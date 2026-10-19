import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Result as Either, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
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
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
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
				forkId && existsSync(fixture.daemonStorePath())
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
			sendRpcRequest(socket, {
				_tag: "ListDaemonSessions",
				projectSlug: "process-test",
				scope: "process-test",
				roots: false,
			});
		evidence["createdParent"] = (await list()).sessions.find(
			({ id }) => id === parentId,
		);
		evidence["createdParentEvents"] = forkEvents(fixture, parentId);
		await sendRpcRequest(
			socket,
			provider === "claude"
				? { _tag: "MoveSessionWorkspace", sessionId: parentId, path: worktree }
				: {
						_tag: "OpenCodeUseWorktree",
						instanceId: "managed-test",
						providerSessionId: parentId,
						path: worktree,
					},
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
		// A Side Thread carries its first prompt; a plain fork is sent one below.
		const sideInputId = randomUUID();
		const fork = await sendRpcRequest(
			socket,
			sideThread
				? {
						_tag: "StartSideThread",
						sessionId: parentId,
						title: "Explain this code",
						inputId: sideInputId,
						text: "Reply with pong.",
					}
				: {
						_tag: "ForkSession",
						originId: browser.originId,
						sessionId: parentId,
					},
		);
		forkId = fork.sessionId;
		const child = (await list()).sessions.find(({ id }) => id === forkId);
		// A Side Thread is contained by its Source; a Fork is a Family Root.
		expect(child?.parentID).toBe(sideThread ? parentId : undefined);
		expect(child).toMatchObject({
			forkedFrom: parentId,
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
			if (sideThread)
				await browser.waitFor(
					(message) =>
						message["type"] === "session_row" &&
						message["id"] === forkId &&
						message["status"] === "idle" &&
						message["lastTurnEndInputId"] === sideInputId,
				);
			else
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
			if (!sideThread)
				await sendRpcRequest(socket, {
					_tag: "input.submit",
					sessionId: forkId,
					inputId: randomUUID(),
					text: "Reply with pong.",
					delivery: "queue",
				});
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
			const instance = Either.getOrThrowWith(
				loadDaemonConfigResult(fixture.configDir),
				(error) => error,
			)?.instances?.find(({ id }) => id === "managed-test");
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
						fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
							permissionId,
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
				const question = await browser.waitFor(
					(message) =>
						message["type"] === "question_pending" &&
						fixture.providerRequestIdForPrompt(String(message["toolId"])) ===
							questionId,
				);
				expect(
					await sendRpcRequest(socket, {
						_tag: "AnswerQuestion",
						projectSlug: "process-test",
						originId: browser.originId,
						commandId: randomUUID(),
						toolId: String(question["toolId"]),
						answers: { "0": "Yes" },
					}),
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
								type === "question.resolved" &&
								data["id"] === fixture.promptIdForProviderRequest(questionId),
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
						fixture.providerRequestIdForPrompt(String(message["toolId"])) ===
							rejectedId,
				);
				evidence["rejectTarget"] = {
					sessionId: forkId,
					questionId: rejectedId,
				};
				evidence["rejectPeer"] = {
					sessionId: peer.id,
					questionId: peerQuestionId,
				};
				await expect(
					browser.rejectQuestion({
						...rejected,
						toolId: `que_${randomUUID()}`,
					}),
				).rejects.toThrow("This prompt is no longer available");
				await browser.rejectQuestion(rejected);
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
								type === "question.resolved" &&
								data["id"] === fixture.promptIdForProviderRequest(rejectedId),
						),
					).toBe(true),
				);
				evidence["rejectedQuestion"] = rejectedId;
				expect(
					forkEvents(fixture, peer.id).some(
						({ type, data }) =>
							type === "question.resolved" &&
							data["id"] === fixture.promptIdForProviderRequest(peerQuestionId),
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

	// A long parent made the fork outlast the browser's 10s ping, so the reply
	// was lost while the server finished: the prompt, sent only after the reply,
	// never went, and each retry made another empty Side Thread.
	it("starts a Side Thread of a long session with its prompt, once, within the ping timeout", async () => {
		const { fixture, socket } = await start(
			"side-thread-long-parent",
			"claude",
		);
		const browser = await fixture.connect();
		const parentId = await browser.createSession("Long parent");
		// Gives the parent the Claude transcript a fork resumes from.
		await browser.send(parentId, "Reply with pong.");
		await fixture.kill();
		const db = new Database(fixture.daemonStorePath());
		try {
			const head = db
				.prepare(
					"SELECT project_id, provider, MAX(stream_version) AS version FROM events WHERE session_id = ?",
				)
				.get(parentId) as {
				project_id: string;
				provider: string;
				version: number;
			};
			const insert = db.prepare(
				"INSERT INTO events (project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			);
			let version = head.version;
			const append = (type: string, data: Record<string, unknown>) =>
				insert.run(
					head.project_id,
					`evt_${randomUUID()}`,
					parentId,
					++version,
					type,
					JSON.stringify(data),
					"{}",
					head.provider,
					Date.now(),
				);
			// Shaped like the reported session: ~85 turns, ~18k events.
			db.transaction(() => {
				for (let turn = 0; turn < 85; turn++) {
					const user = `user-${turn}`;
					const assistant = `msg-${turn}`;
					append("message.created", {
						sessionId: parentId,
						messageId: user,
						role: "user",
					});
					append("text.delta", {
						messageId: user,
						partId: `${user}-0`,
						text: `Question ${turn}`,
					});
					append("message.created", {
						sessionId: parentId,
						messageId: assistant,
						role: "assistant",
					});
					for (let step = 0; step < 15; step++) {
						const tool = `${assistant}-tool-${step}`;
						append("thinking.start", {
							messageId: assistant,
							partId: `${tool}-thinking`,
						});
						append("thinking.end", {
							messageId: assistant,
							partId: `${tool}-thinking`,
						});
						append("tool.started", {
							messageId: assistant,
							partId: tool,
							toolName: "Bash",
							callId: tool,
							input: { tool: "Bash", command: "x".repeat(600) },
						});
						append("tool.running", { messageId: assistant, partId: tool });
						append("tool.running", { messageId: assistant, partId: tool });
						append("tool.completed", {
							messageId: assistant,
							partId: tool,
							result: "r".repeat(6000),
							duration: 0,
						});
						for (let delta = 0; delta < 8; delta++)
							append("text.delta", {
								messageId: assistant,
								partId: `${tool}-text`,
								text: "word ".repeat(20),
							});
					}
					append("turn.completed", {
						messageId: assistant,
						cost: 0,
						tokens: { input: 1, output: 1 },
						duration: 1,
					});
					append("session.status", { sessionId: parentId, status: "idle" });
				}
			})();
			evidence["parentEvents"] = version + 1;
		} finally {
			db.close();
		}
		// Startup recovery projects the seeded history into the read model, which
		// decides the messages a Claude fork keeps.
		await fixture.restart({ startupTimeoutMs: 60_000 });
		const request = {
			_tag: "StartSideThread" as const,
			sessionId: parentId,
			title: "What does this do?",
			inputId: randomUUID(),
			text: "What does this do?",
		};
		const started = performance.now();
		// Two identical starts in flight at once, as from two tabs.
		const [first, duplicate] = await Promise.all([
			sendRpcRequest(socket, request),
			sendRpcRequest(socket, request),
		]);
		evidence["startSideThreadMs"] = Math.round(performance.now() - started);
		forkId = first.sessionId;
		expect(evidence["startSideThreadMs"]).toBeLessThan(10_000);
		expect(duplicate.sessionId).toBe(forkId);
		// A retry after a lost reply lands on the Side Thread the prompt reached.
		expect((await sendRpcRequest(socket, request)).sessionId).toBe(forkId);

		// The daemon dies the moment the second Side Thread exists, so its
		// prompt may not be admitted yet; the retry must resume that thread.
		const crashed = {
			...request,
			inputId: randomUUID(),
		};
		void sendRpcRequest(socket, crashed).catch(() => undefined);
		const readStarted = new Database(fixture.daemonStorePath(), {
			readonly: true,
		});
		const crashedId = await vi.waitFor(
			() => {
				const row = readStarted
					.prepare(
						"SELECT session_id FROM events WHERE project_id = 'process-test' AND type = 'session.created' AND json_extract(data, '$.startInputId') = ?",
					)
					.get(crashed.inputId) as { session_id: string } | undefined;
				if (!row) throw new Error("Side Thread not forked yet");
				return row.session_id;
			},
			{ timeout: 10_000, interval: 5 },
		);
		readStarted.close();
		await fixture.kill();
		evidence["crashedBeforeAdmission"] = !forkEvents(fixture, crashedId).some(
			({ type }) => type === "input.admitted",
		);
		await fixture.restart({ startupTimeoutMs: 60_000 });
		expect((await sendRpcRequest(socket, crashed)).sessionId).toBe(crashedId);

		const sideThreads = (
			await sendRpcRequest(socket, {
				_tag: "ListDaemonSessions",
				projectSlug: "process-test",
				scope: "process-test",
				roots: false,
			})
		).sessions.filter(({ parentID }) => parentID === parentId);
		expect(sideThreads.map(({ id }) => id).sort()).toEqual(
			[forkId, crashedId].sort(),
		);
		for (const [sessionId, inputId] of [
			[first.sessionId, request.inputId],
			[crashedId, crashed.inputId],
		] as const) {
			await vi.waitFor(
				() =>
					expect(
						forkEvents(fixture, sessionId)
							.filter(({ type }) => type === "input.sent")
							.map(({ data }) => data["inputId"]),
					).toEqual([inputId]),
				{ timeout: 10_000 },
			);
			expect(
				forkEvents(fixture, sessionId).filter(
					({ type }) => type === "input.admitted",
				),
			).toHaveLength(1);
		}
	}, 180_000);

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
		await sendRpcRequest(socket, {
			_tag: "SaveProject",
			slug: "process-test",
			folders: [fixture.projectDir, extra],
		});
		const browser = await fixture.connect();
		const parentId = await browser.createSession(
			"Parent launched in an extra worktree",
		);
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: parentId,
			path: extraWorktree,
		});
		expect(
			(await browser.send(parentId, "Reply with pong.")).chunks.join(""),
		).toBe(responseChunks("Reply with pong.").join(""));
		const parentQuery = fixture
			.claudeOptions()
			.find(({ prompt }) => prompt !== undefined);
		expect(parentQuery?.options["cwd"]).toBe(extraWorktree);
		evidence["parentQuery"] = parentQuery;
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: parentId,
			path: worktree,
		});
		if (removed)
			git(fixture.projectDir, "worktree", "remove", "--force", worktree);
		const fork = await sendRpcRequest(socket, {
			_tag: "ForkSession",
			originId: browser.originId,
			sessionId: parentId,
		});
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
