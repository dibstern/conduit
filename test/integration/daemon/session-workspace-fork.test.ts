import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AnswerQuestion,
	ForkSession,
	ListDaemonSessions,
	MoveSessionWorkspace,
	OpenCodeUseWorktree,
	SaveProject,
	StartSideThread,
	SubmitInput,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { SessionWorkspaceChangedPayloadSchema } from "../../../src/lib/persistence/events.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Failure modes: a fork defaults to main, loses workspace metadata, publishes
// before inheritance, launches its first turn there, or misses the turn's
// completion events. Worktree questions and always permissions must stay scoped
// to their native folder; stale rejects must preserve another session's question.
// Side Threads use the same fork seam, including OpenCode
// whose user moves are unsupported. A queued move to another repository must
// not redirect the lookup of the parent's existing native transcript.
const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];

function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function forkEvents(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.projectStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT sequence, type, data FROM events WHERE session_id = ? AND type IN ('session.created', 'session.workspace_changed', 'session.status', 'turn.completed', 'question.resolved', 'message.created', 'input.admitted', 'input.sent') ORDER BY sequence",
			)
			.all(sessionId)
			.map((row) => {
				const event = row as {
					sequence: number;
					type: string;
					data: string;
				};
				return {
					sequence: event.sequence,
					type: event.type,
					data: JSON.parse(event.data) as Record<string, unknown>,
				};
			});
	} finally {
		db.close();
	}
}

describe("Forked session workspaces through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};
	let forkId: string | undefined;

	async function start(name: string, provider: "claude" | "opencode") {
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		forkId = undefined;
		harness = ProcessHarness.create({
			managedOpenCode: provider === "opencode",
		});
		const fixture = harness;
		writeFileSync(
			join(fixture.root, "claude", "conduit-test-record-forks"),
			"record\n",
		);
		git(fixture.projectDir, "init", "-b", "main");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Workspace fork test",
			"-c",
			"user.email=workspace@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Initial commit",
		);
		const worktree = join(fixture.root, "parent-worktree");
		git(fixture.projectDir, "worktree", "add", "-b", "feature/fork", worktree);
		await fixture.restart({ startupTimeoutMs: 30_000 });
		return {
			fixture,
			worktree: realpathSync(worktree),
			socket: join(fixture.configDir, "relay.sock"),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["events"] =
				forkId && existsSync(fixture.projectStorePath())
					? forkEvents(fixture, forkId)
					: [];
			evidence["queries"] = fixture.claudeOptions();
			evidence["requests"] = fixture.opencodeRequests();
			evidence["errors"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
			if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/q5u6-1-7-fork-${scenario}.json`,
					JSON.stringify(evidence, null, 2)
						.replaceAll(
							fixture.root.replace(/^\/tmp\//, "/private/tmp/"),
							"<root>",
						)
						.replaceAll(fixture.root, "<root>"),
				);
				harness = undefined;
				vi.unstubAllEnvs();
			}
		}
	});

	it.each([
		{ provider: "claude" as const, sideThread: false },
		{ provider: "claude" as const, sideThread: true },
		{ provider: "opencode" as const, sideThread: false },
		{ provider: "opencode" as const, sideThread: true },
	])("$provider fork inherits its parent's workspace before its first turn (Side Thread: $sideThread)", async ({
		provider,
		sideThread,
	}) => {
		const { fixture, worktree, socket } = await start(
			`${provider}-${sideThread ? "side-thread" : "session"}`,
			provider,
		);
		const browser = await fixture.connect();
		const parentId = await browser.createSession(
			"Parent in a worktree",
			provider === "opencode" ? "managed-test" : undefined,
			provider,
		);
		const list = () =>
			sendRpcRequest(
				socket,
				new ListDaemonSessions({
					projectSlug: "process-test",
					scope: "process-test",
					roots: false,
				}),
			);
		evidence["createdParent"] = (await list()).sessions.find(
			({ id }) => id === parentId,
		);
		evidence["createdParentEvents"] = forkEvents(fixture, parentId);
		await sendRpcRequest(
			socket,
			provider === "claude"
				? new MoveSessionWorkspace({
						projectSlug: "process-test",
						sessionId: parentId,
						path: worktree,
					})
				: new OpenCodeUseWorktree({
						instanceId: "managed-test",
						providerSessionId: parentId,
						path: worktree,
					}),
		);
		if (provider === "claude") {
			expect(
				(await browser.send(parentId, "Reply with pong.")).chunks.join(""),
			).toBe(responseChunks("Reply with pong.").join(""));
		}
		const parent = (await list()).sessions.find(({ id }) => id === parentId);
		expect(parent?.workspace).toMatchObject({
			worktrees: { [fixture.projectDir]: worktree },
			origin: "existing",
		});
		const fork = await sendRpcRequest(
			socket,
			sideThread
				? new StartSideThread({
						projectSlug: "process-test",
						parentSessionId: parentId,
						title: "Explain this code",
					})
				: new ForkSession({
						projectSlug: "process-test",
						originId: browser.originId,
						sessionId: parentId,
					}),
		);
		forkId = fork.sessionId;
		const child = (await list()).sessions.find(({ id }) => id === forkId);
		expect(child).toMatchObject({
			parentID: parentId,
			workspace: {
				cause: "launch",
				worktrees: parent?.workspace?.worktrees,
				origin: parent?.workspace?.origin,
			},
			git: { branch: "feature/fork" },
		});
		const initial = forkEvents(fixture, forkId);
		const move = initial.find(
			({ type }) => type === "session.workspace_changed",
		);
		expect(move).toBeDefined();
		const payload = Schema.decodeUnknownSync(
			SessionWorkspaceChangedPayloadSchema,
		)(move?.data);
		expect(payload).toMatchObject({
			sessionId: forkId,
			path: worktree,
			cause: "launch",
			worktrees: parent?.workspace?.worktrees,
			origin: parent?.workspace?.origin,
		});
		expect(initial[0]?.type).toBe("session.created");
		for (const event of initial.filter(
			({ type }) => type === "message.created",
		))
			expect(move?.sequence).toBeLessThan(event.sequence);
		evidence["parent"] = parent;
		evidence["fork"] = child;
		await browser.view(forkId);
		if (provider === "claude") {
			expect(
				(await browser.send(forkId, "Reply with pong.")).chunks.join(""),
			).toBe(responseChunks("Reply with pong.").join(""));
			const runnerPids = new Set(
				fixture.marks.flatMap((mark) =>
					mark.kind === "runner-started" && mark.sessionId === forkId
						? [mark.pid]
						: [],
				),
			);
			const queries = fixture
				.claudeOptions()
				.filter(
					({ pid, options }) =>
						runnerPids.has(pid) && options["maxTurns"] !== 0,
				);
			expect(queries[0]?.options["cwd"]).toBe(worktree);
		} else {
			await sendRpcRequest(
				socket,
				new SubmitInput({
					projectSlug: "process-test",
					sessionId: forkId,
					inputId: randomUUID(),
					text: "Reply with pong.",
					delivery: "queue",
				}),
			);
			await vi.waitFor(() => {
				const request = fixture
					.opencodeRequests()
					.find(
						({ url }) =>
							url.split("?")[0] === `/session/${forkId}/prompt_async`,
					);
				const directory = request
					? (new URL(request.url, "http://opencode.test").searchParams.get(
							"directory",
						) ?? decodeURIComponent(request.directory ?? ""))
					: undefined;
				expect(directory).toBe(worktree);
			});
			const instance = loadDaemonConfig(fixture.configDir)?.instances?.find(
				({ id }) => id === "managed-test",
			);
			if (!instance?.port) throw new Error("Managed OpenCode did not start");
			const nativeHeaders = {
				Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"] ?? "opencode"}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
			};
			const readNative = async (path: string) => {
				const response = await fetch(
					`http://127.0.0.1:${instance.port}${path}`,
					{
						headers: nativeHeaders,
						signal: AbortSignal.timeout(2000),
					},
				);
				expect(response.ok).toBe(true);
				return (await response.json()) as unknown;
			};
			const native = (await readNative(`/session/${forkId}`)) as {
				directory: string;
			};
			evidence["nativeDirectory"] = native.directory;
			expect(realpathSync(native.directory)).toBe(worktree);
			const moveRequest = fixture
				.opencodeRequestBodies()
				.find(
					({ path }) => path === "/experimental/control-plane/move-session",
				);
			expect(JSON.parse(moveRequest?.body ?? "{}")).toEqual({
				sessionID: forkId,
				destination: { directory: worktree },
				moveChanges: false,
			});
			evidence["nativeMove"] = JSON.parse(moveRequest?.body ?? "{}");
			if (!sideThread) {
				const permissionId = `per_${randomUUID()}`;
				const permissionPattern = "echo workspace-fork";
				await fixture.addOpenCodePrompt(
					"permission",
					worktree,
					{
						id: permissionId,
						sessionID: forkId,
						permission: "bash",
						patterns: [permissionPattern],
						always: [permissionPattern],
						metadata: {},
					},
					"managed-test",
				);
				const permission = await browser.waitFor(
					(message) =>
						message["type"] === "permission_pending" &&
						message["requestId"] === permissionId,
				);
				await browser.answerApproval(permission, "allow_always");
				const updated = (await readNative(`/session/${forkId}`)) as {
					permission?: readonly {
						permission: string;
						pattern: string;
						action: string;
					}[];
				};
				expect.soft(updated.permission ?? []).toContainEqual({
					permission: "bash",
					pattern: permissionPattern,
					action: "allow",
				});
				evidence["permissionRules"] = updated.permission;
				const questionId = `que_${randomUUID()}`;
				await fixture.addOpenCodePrompt(
					"question",
					worktree,
					{
						id: questionId,
						sessionID: forkId,
						questions: [
							{
								question: "Continue in this worktree?",
								header: "Continue",
								options: [{ label: "Yes" }],
							},
						],
					},
					"managed-test",
				);
				await browser.waitFor(
					(message) =>
						message["type"] === "question_pending" &&
						message["toolId"] === questionId,
				);
				expect(
					await sendRpcRequest(
						socket,
						new AnswerQuestion({
							projectSlug: "process-test",
							originId: browser.originId,
							commandId: randomUUID(),
							toolId: questionId,
							answers: { "0": "Yes" },
						}),
					),
				).toEqual({ ok: true });
				expect(
					await readNative(
						`/question?directory=${encodeURIComponent(worktree)}`,
					),
				).toEqual([]);
				await vi.waitFor(() =>
					expect(
						forkEvents(fixture, forkId ?? "").some(
							({ type, data }) =>
								type === "question.resolved" && data["id"] === questionId,
						),
					).toBe(true),
				);
				evidence["resolvedQuestion"] = questionId;
				const peerResponse = await fetch(
					`http://127.0.0.1:${instance.port}/session?directory=${encodeURIComponent(worktree)}`,
					{
						method: "POST",
						headers: { ...nativeHeaders, "Content-Type": "application/json" },
						body: JSON.stringify({ title: "Peer in the same worktree" }),
						signal: AbortSignal.timeout(2000),
					},
				);
				expect(peerResponse.ok).toBe(true);
				const peer = (await peerResponse.json()) as {
					id: string;
					directory: string;
				};
				expect(realpathSync(peer.directory)).toBe(worktree);
				const peerQuestionId = `que_${randomUUID()}`;
				await fixture.addOpenCodePrompt(
					"question",
					worktree,
					{
						id: peerQuestionId,
						sessionID: peer.id,
						questions: [
							{
								question: "Keep the peer question pending?",
								header: "Peer",
								options: [{ label: "Yes" }],
							},
						],
					},
					"managed-test",
				);
				const rejectedId = `que_${randomUUID()}`;
				await fixture.addOpenCodePrompt(
					"question",
					worktree,
					{
						id: rejectedId,
						sessionID: forkId,
						questions: [
							{
								question: "Continue in this worktree?",
								header: "Continue",
								options: [{ label: "Yes" }],
							},
						],
					},
					"managed-test",
				);
				const rejected = await browser.waitFor(
					(message) =>
						message["type"] === "question_pending" &&
						message["toolId"] === rejectedId,
				);
				evidence["rejectTarget"] = {
					sessionId: forkId,
					questionId: rejectedId,
				};
				evidence["rejectPeer"] = {
					sessionId: peer.id,
					questionId: peerQuestionId,
				};
				await browser.rejectQuestion({
					...rejected,
					toolId: `que_${randomUUID()}`,
				});
				const remaining = (await readNative(
					`/question?directory=${encodeURIComponent(worktree)}`,
				)) as { id: string; sessionID: string }[];
				evidence["remainingQuestions"] = remaining;
				expect(
					remaining.map(({ id, sessionID }) => ({ id, sessionID })),
				).toEqual([{ id: peerQuestionId, sessionID: peer.id }]);
				await vi.waitFor(() =>
					expect(
						forkEvents(fixture, forkId ?? "").some(
							({ type, data }) =>
								type === "question.resolved" && data["id"] === rejectedId,
						),
					).toBe(true),
				);
				evidence["rejectedQuestion"] = rejectedId;
				expect(
					forkEvents(fixture, peer.id).some(
						({ type, data }) =>
							type === "question.resolved" && data["id"] === peerQuestionId,
					),
				).toBe(false);
			}
			const assistantId = `msg_${randomUUID()}`;
			await fixture.emitOpenCodeEvent(
				{
					directory: worktree,
					payload: {
						id: `evt_${randomUUID()}`,
						type: "message.updated",
						properties: {
							info: {
								id: assistantId,
								sessionID: forkId,
								role: "assistant",
								time: { created: Date.now(), completed: Date.now() + 1 },
							},
						},
					},
				},
				"managed-test",
			);
			await vi.waitFor(
				() => {
					const completed = forkEvents(fixture, forkId ?? "");
					const sent = completed.find(({ type }) => type === "input.sent");
					const busy = completed.find(
						({ sequence, type, data }) =>
							sequence > (sent?.sequence ?? Infinity) &&
							type === "session.status" &&
							data["status"] === "busy",
					);
					const idle = completed.find(
						({ sequence, type, data }) =>
							sequence > (busy?.sequence ?? Infinity) &&
							type === "session.status" &&
							data["status"] === "idle",
					);
					expect(idle).toBeDefined();
					expect(
						completed.some(
							({ type, data }) =>
								type === "turn.completed" && data["messageId"] === assistantId,
						),
					).toBe(true);
				},
				{ timeout: 10_000 },
			);
		}
		const firstInput = forkEvents(fixture, forkId).find(
			({ type }) => type === "input.admitted",
		);
		expect(firstInput).toBeDefined();
		expect(move?.sequence).toBeLessThan(firstInput?.sequence ?? 0);
	}, 60_000);

	it.each([
		false,
		true,
	])("Claude finds the native transcript after moving to another repository before the next turn (removed: %s)", async (removed) => {
		const { fixture, socket, worktree } = await start(
			`claude-extra-repository-${removed ? "removed" : "existing"}`,
			"claude",
		);
		const extra = join(fixture.root, "extra-repository");
		mkdirSync(extra);
		git(extra, "init", "-b", "extra-main");
		git(
			extra,
			"-c",
			"user.name=Workspace fork test",
			"-c",
			"user.email=workspace@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Initial extra-repository commit",
		);
		const linked = join(fixture.root, "extra-worktree");
		git(extra, "worktree", "add", "-b", "feature/extra-fork", linked);
		const extraWorktree = realpathSync(linked);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, extra],
			}),
		);
		const browser = await fixture.connect();
		const parentId = await browser.createSession(
			"Parent launched in an extra worktree",
		);
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId: parentId,
				path: extraWorktree,
			}),
		);
		expect(
			(await browser.send(parentId, "Reply with pong.")).chunks.join(""),
		).toBe(responseChunks("Reply with pong.").join(""));
		const parentQuery = fixture
			.claudeOptions()
			.find(({ prompt }) => prompt !== undefined);
		expect(parentQuery?.options["cwd"]).toBe(extraWorktree);
		evidence["parentQuery"] = parentQuery;
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId: parentId,
				path: worktree,
			}),
		);
		if (removed)
			git(fixture.projectDir, "worktree", "remove", "--force", worktree);
		const fork = await sendRpcRequest(
			socket,
			new ForkSession({
				projectSlug: "process-test",
				originId: browser.originId,
				sessionId: parentId,
			}),
		);
		forkId = fork.sessionId;
		const inherited = forkEvents(fixture, forkId).find(
			({ type }) => type === "session.workspace_changed",
		);
		expect(inherited?.data).toMatchObject({
			path: worktree,
			cause: "launch",
			worktrees: { [fixture.projectDir]: worktree },
			origin: "existing",
		});
		evidence["nativeForks"] = fixture.marks.filter(
			({ kind }) => kind === "native-fork",
		);
		await browser.view(forkId);
		expect(
			(await browser.send(forkId, "Reply with pong.")).chunks.join(""),
		).toBe(responseChunks("Reply with pong.").join(""));
		const runnerPids = new Set(
			fixture.marks.flatMap((mark) =>
				mark.kind === "runner-started" && mark.sessionId === forkId
					? [mark.pid]
					: [],
			),
		);
		const firstQuery = fixture
			.claudeOptions()
			.find(
				({ pid, options }) => runnerPids.has(pid) && options["maxTurns"] !== 0,
			);
		expect(firstQuery?.options["cwd"]).toBe(
			removed ? fixture.projectDir : worktree,
		);
	}, 60_000);
});
