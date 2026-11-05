/*
 * Running sessions resume after a daemon restart (82tn.15). Failure modes, written before the code
 * (numbering from the lane audit):
 * 1. A Claude turn in a worktree and an OpenCode turn in the main folder (and the other way round)
 *    are re-sent, lost, or continue in another directory; a new runner or OpenCode process replaces
 *    the live one.
 * 2. A pending approval vanishes, changes id, is asked twice, or cannot be answered after restart.
 * 3. A queued message is lost, sent twice, or sent before the running turn ends.
 * 5. A second restart during the same turns re-sends or loses them.
 * 6. A browser that connects before adoption finishes sees no approval, or its input reaches a new
 *    runner.
 * 4. A project whose folder is gone at restart: the daemon fails to start, the queued message is
 *    failed or lost, or the live runner is replaced once the folder returns.
 * 7. A session deleted while adoption runs: its runner is adopted and kept alive, the delete fails,
 *    or the other session's turn is disturbed.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function git(directory: string, ...args: string[]) {
	const env = { ...process.env };
	for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"])
		delete env[key];
	return execFileSync("git", ["-C", directory, ...args], {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function sdkProof(fixture: ProcessHarness) {
	return readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function store(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			sends: db
				.prepare(`SELECT o.command_id, o.status, o.error_code, r.status AS receipt
					FROM provider_command_outbox o
					LEFT JOIN command_receipts r ON r.command_id = o.command_id
					WHERE o.session_id = ? AND o.effect_type = 'send_turn'
					ORDER BY o.request_sequence`)
				.all(sessionId) as Array<{
				command_id: string;
				status: string;
				error_code: string | null;
				receipt: string | null;
			}>,
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId) as Array<{ state: string }>,
			receipts: (
				db
					.prepare(
						"SELECT command_id FROM command_receipts WHERE session_id = ?",
					)
					.all(sessionId) as Array<{ command_id: string }>
			).map(({ command_id }) => command_id),
			busy:
				(
					db
						.prepare(`SELECT EXISTS (SELECT 1 FROM provider_runs
							WHERE session_id = ? AND status IN ('pending', 'running')) AS busy`)
						.get(sessionId) as { busy: number }
				).busy === 1,
			approvals: db
				.prepare(
					"SELECT id, status FROM pending_approvals WHERE session_id = ? ORDER BY id",
				)
				.all(sessionId) as Array<{ id: string; status: string }>,
		};
	} finally {
		db.close();
	}
}

describe("82tn.15: running sessions resume after restart", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {};

	afterEach(async () => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			harness = undefined;
			mkdirSync("test-results", { recursive: true });
			const file = "test-results/82tn-15-restart-resume.json";
			writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
		}
	});

	// test-waits-allow timeout-override: daemon restarts with several runners exceed the 30 s default.
	it("adopts Claude and OpenCode turns in a worktree and the main folder across two restarts", async () => {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			restartProof: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		mkdirSync(fixture.projectDir, { recursive: true });
		git(fixture.projectDir, "init", "-b", "main");
		git(
			fixture.projectDir,
			"-c",
			"user.name=Restart test",
			"-c",
			"user.email=restart@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Initial commit",
		);
		await fixture.restart({ opencodeIdleTimeoutMs: 120_000 });
		const socket = join(fixture.configDir, "relay.sock");
		let browser: ProcessBrowser = await fixture.connect();
		const main = realpathSync(fixture.projectDir);
		const create = async (
			title: string,
			provider: "claude" | "opencode",
			newWorktree: boolean,
		) => {
			const { sessionId } = await sendRpcRequest(socket, {
				_tag: "CreateSession",
				permissionMode: "ask",
				projectSlug: "process-test",
				originId: browser.originId,
				title,
				providerId: provider,
				...(provider === "opencode"
					? {
							instanceId: MANAGED_OPENCODE_ACCOUNT_ID,
							model: { providerId: "fake", modelId: "fake-model" },
						}
					: { model: { providerId: "claude", modelId: "sonnet" } }),
				...(newWorktree ? { newWorktree: true } : {}),
			} as Parameters<typeof sendRpcRequest>[1] & { _tag: "CreateSession" });
			const { sessions } = await sendRpcRequest(socket, {
				_tag: "ListDaemonSessions",
				projectSlug: "process-test",
			});
			const worktree = sessions.find(({ id }) => id === sessionId)?.workspace
				?.worktrees[fixture.projectDir];
			if (newWorktree && !worktree) throw new Error(`${title}: no worktree`);
			await browser.view(sessionId);
			return {
				title,
				provider,
				sessionId,
				directory: worktree ? realpathSync(worktree) : main,
			};
		};
		const sessions = {
			claudeWorktree: await create("Claude worktree", "claude", true),
			claudeMain: await create("Claude main", "claude", false),
			openCodeWorktree: await create("OpenCode worktree", "opencode", true),
			openCodeMain: await create("OpenCode main", "opencode", false),
		};
		expect(sessions.claudeWorktree.directory).not.toBe(main);
		expect(sessions.openCodeWorktree.directory).not.toBe(main);

		const submit = async (sessionId: string, text: string) => {
			const inputId = randomUUID();
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId,
					delivery: "queue",
					text,
				}),
			);
			return inputId;
		};
		const enqueued = (prompt: string) =>
			sdkProof(fixture).filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === prompt,
			).length;
		const promptAsync = (sessionId: string) =>
			fixture
				.opencodeRequests()
				.filter(({ url }) =>
					url.includes(`/session/${sessionId}/prompt_async`),
				);

		// Claude worktree: an approval left pending.
		await submit(sessions.claudeWorktree.sessionId, "approval-restart");
		const claudeApproval = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["sessionId"] === sessions.claudeWorktree.sessionId,
		);
		// Claude main: a long turn held open, and a message queued behind it.
		await submit(sessions.claudeMain.sessionId, "upgrade-long-turn");
		// test-waits-allow polling: the fake SDK's proof file has no event.
		await vi.waitFor(() => expect(enqueued("upgrade-long-turn")).toBe(1), {
			timeout: 15_000,
		});
		await submit(sessions.claudeMain.sessionId, "queued-after-restart");
		// OpenCode: both turns held; the worktree one asks a permission.
		writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
		const userIds = new Map<string, string>();
		for (const session of [sessions.openCodeWorktree, sessions.openCodeMain]) {
			await submit(session.sessionId, `opencode-turn ${session.title}`);
			// test-waits-allow polling: the fake OpenCode request log has no event.
			await vi.waitFor(
				() => expect(promptAsync(session.sessionId)).toHaveLength(1),
				{ timeout: 15_000 },
			);
			// Real OpenCode echoes the user message at once; the held fake does not.
			const { messageID } = JSON.parse(
				fixture
					.opencodeRequestBodies()
					.find(
						({ path }) => path === `/session/${session.sessionId}/prompt_async`,
					)?.body ?? "{}",
			) as { messageID?: string };
			if (!messageID) throw new Error("prompt_async without a message id");
			userIds.set(session.sessionId, messageID);
			await fixture.emitOpenCodeEvent({
				directory: session.directory,
				payload: {
					id: `evt_${randomUUID()}`,
					type: "message.updated",
					properties: {
						info: {
							id: messageID,
							sessionID: session.sessionId,
							role: "user",
							time: { created: Date.now() },
						},
					},
				},
			});
		}
		await fixture.addOpenCodePrompt(
			"permission",
			sessions.openCodeWorktree.directory,
			{
				id: "restart-worktree-permission",
				sessionID: sessions.openCodeWorktree.sessionId,
				permission: "bash",
				patterns: ["echo restart"],
				metadata: {},
				always: [],
			},
		);
		await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
					"restart-worktree-permission",
		);
		const assistantText = (
			session: (typeof sessions)["openCodeMain"],
			text: string,
			completed: boolean,
		) =>
			Promise.all([
				fixture.emitOpenCodeEvent({
					directory: session.directory,
					payload: {
						id: `evt_${randomUUID()}`,
						type: "message.updated",
						properties: {
							info: {
								id: `msg_reply_${session.sessionId}`,
								sessionID: session.sessionId,
								role: "assistant",
								parentID: userIds.get(session.sessionId),
								time: {
									created: Date.now(),
									...(completed ? { completed: Date.now() } : {}),
								},
								...(completed ? { finish: "stop" } : {}),
							},
						},
					},
				}),
				fixture.emitOpenCodeEvent({
					directory: session.directory,
					payload: {
						id: `evt_${randomUUID()}`,
						type: "message.part.updated",
						properties: {
							part: {
								id: `prt_reply_${session.sessionId}`,
								sessionID: session.sessionId,
								messageID: `msg_reply_${session.sessionId}`,
								type: "text",
								text,
							},
						},
					},
				}),
			]);
		await assistantText(sessions.openCodeMain, "Still running", false);

		// The same runner can be marked more than once across restarts; count its pid once.
		const claudeRunner = (sessionId: string) => [
			...new Set(
				fixture.marks.flatMap((mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId
						? [mark.pid]
						: [],
				),
			),
		];
		const claudeCwd = (sessionId: string) =>
			fixture
				.claudeOptions()
				.filter(({ pid }) => claudeRunner(sessionId).includes(pid))
				.map(({ options }) => realpathSync(String(options["cwd"])));
		const openCodeDirectories = (sessionId: string) =>
			promptAsync(sessionId).map(({ directory }) =>
				directory ? realpathSync(decodeURIComponent(directory)) : null,
			);
		const processes = () =>
			Object.fromEntries(
				Object.entries(sessions).map(([key, session]) => [
					key,
					session.provider === "claude"
						? {
								runners: claudeRunner(session.sessionId),
								directories: claudeCwd(session.sessionId),
							}
						: {
								openCodePids: [
									...new Set(
										promptAsync(session.sessionId).map(({ pid }) => pid),
									),
								],
								directories: openCodeDirectories(session.sessionId),
							},
				]),
			);
		const before = processes();
		evidence["sessions"] = Object.fromEntries(
			Object.entries(sessions).map(([key, session]) => [
				key,
				{
					provider: session.provider,
					directory: session.directory.replace(fixture.root, "<root>"),
				},
			]),
		);
		evidence["before"] = before;
		for (const session of Object.values(sessions))
			expect(store(fixture, session.sessionId).busy).toBe(true);

		// Two restarts in a row; a browser connects right after the first, before adoption is seen.
		const openCodePid = fixture.opencodeRequests().at(-1)?.pid;
		await browser.close();
		await fixture.kill();
		await fixture.restart({ skipBrowserProbe: true });
		browser = await fixture.connect(sessions.claudeWorktree.sessionId);
		await browser.view(sessions.claudeWorktree.sessionId);
		await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === claudeApproval["requestId"],
		);
		await browser.close();
		await fixture.kill();
		await fixture.restart({ skipBrowserProbe: true });
		browser = await fixture.connect();
		for (const session of Object.values(sessions))
			await browser.view(session.sessionId);

		// Same processes, same directories, nothing re-sent.
		const adopted = processes();
		evidence["afterRestarts"] = adopted;
		expect(adopted).toEqual(before);
		expect(() => process.kill(Number(openCodePid), 0)).not.toThrow();
		for (const session of Object.values(sessions))
			expect(store(fixture, session.sessionId).busy).toBe(true);
		expect(enqueued("queued-after-restart")).toBe(0);

		// Approvals kept their ids and are answerable.
		const recoveredClaude = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["sessionId"] === sessions.claudeWorktree.sessionId,
		);
		expect(recoveredClaude["requestId"]).toBe(claudeApproval["requestId"]);
		const recoveredOpenCode = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
					"restart-worktree-permission",
		);
		evidence["approvals"] = {
			claudeWorktree: store(fixture, sessions.claudeWorktree.sessionId)
				.approvals.length,
			openCodeWorktree: store(fixture, sessions.openCodeWorktree.sessionId)
				.approvals.length,
		};
		await browser.answerApproval(recoveredClaude, "allow");
		await browser.answerApproval(recoveredOpenCode, "allow");
		writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
		for (const session of [sessions.openCodeWorktree, sessions.openCodeMain]) {
			await assistantText(session, "Finished after restart", true);
			await fixture.setOpenCodeStatus(session.directory, session.sessionId, {
				type: "idle",
			});
		}
		// test-waits-allow polling: durable run state of four sessions has no single event.
		await vi.waitFor(
			() => {
				for (const session of Object.values(sessions))
					expect(store(fixture, session.sessionId).busy).toBe(false);
				expect(enqueued("queued-after-restart")).toBe(1);
			},
			{ timeout: 30_000 },
		);

		// The next message goes through, in the same directory.
		rmSync(join(fixture.configDir, "fake-opencode-hold-turn"));
		for (const session of Object.values(sessions)) {
			const reply = await browser.send(
				session.sessionId,
				session.provider === "claude" ? "next-after-restart" : "next-turn",
				30_000,
			);
			if (session.provider === "claude")
				expect(reply.chunks.join("")).toBe(
					responseChunks("next-after-restart").join(""),
				);
		}
		const after = processes();
		evidence["after"] = after;
		for (const [key, session] of Object.entries(sessions)) {
			const record = after[key] as { directories: Array<string | null> };
			expect(new Set(record.directories)).toEqual(new Set([session.directory]));
		}
		expect(enqueued("approval-restart")).toBe(1);
		expect(enqueued("upgrade-long-turn")).toBe(1);
		expect(enqueued("queued-after-restart")).toBe(1);
		expect(
			sdkProof(fixture).filter((mark) => mark["kind"] === "approval"),
		).toHaveLength(1);

		// One receipt per send, every send completed.
		const receipts = Object.fromEntries(
			Object.entries(sessions).map(([key, session]) => {
				const state = store(fixture, session.sessionId);
				const ids = new Map<string, string>();
				const name = (id: string) => {
					if (!ids.has(id)) ids.set(id, `${key}-${ids.size + 1}`);
					return ids.get(id);
				};
				expect(new Set(state.receipts).size).toBe(state.receipts.length);
				if (session.provider === "opencode")
					expect(promptAsync(session.sessionId)).toHaveLength(
						state.sends.length,
					);
				return [
					key,
					state.sends.map(({ command_id, status, error_code, receipt }) => ({
						command: name(command_id),
						status,
						error: error_code,
						receipt,
					})),
				];
			}),
		);
		evidence["receipts"] = receipts;
		evidence["turns"] = Object.fromEntries(
			Object.entries(sessions).map(([key, session]) => [
				key,
				store(fixture, session.sessionId).turns.map(({ state }) => state),
			]),
		);
		for (const sends of Object.values(receipts))
			for (const send of sends)
				expect(send).toMatchObject({
					status: "completed",
					receipt: expect.any(String),
				});
	}, 240_000);

	async function heldClaude(titles: readonly string[]) {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			restartProof: true,
		});
		harness = fixture;
		await fixture.restart();
		const browser = await fixture.connect();
		const ids: string[] = [];
		for (const title of titles) {
			const sessionId = await browser.createSession(title);
			await Effect.runPromise(
				browser.rpc["input.submit"]({
					sessionId,
					originId: browser.originId,
					inputId: randomUUID(),
					delivery: "queue",
					text: "upgrade-long-turn",
				}),
			);
			ids.push(sessionId);
		}
		const enqueued = (prompt: string) =>
			sdkProof(fixture).filter(
				(mark) => mark["kind"] === "enqueue" && mark["request"] === prompt,
			).length;
		// test-waits-allow polling: the fake SDK's proof file has no event.
		await vi.waitFor(
			() => expect(enqueued("upgrade-long-turn")).toBe(titles.length),
			{ timeout: 15_000 },
		);
		const runner = (sessionId: string) => {
			const mark = fixture.marks.find(
				(item) =>
					item.kind === "runner-started" && item.sessionId === sessionId,
			);
			if (mark?.kind !== "runner-started") throw new Error("Missing runner");
			return mark.pid;
		};
		return { fixture, browser, ids, enqueued, runner };
	}

	// test-waits-allow timeout-override: daemon restarts with several runners exceed the 30 s default.
	it("keeps a turn and its queued message while the project folder is gone, then resumes when it returns", async () => {
		const { fixture, browser, ids, enqueued, runner } = await heldClaude([
			"Folder gone",
		]);
		const [sessionId = ""] = ids;
		const pid = runner(sessionId);
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "queued-while-gone",
			}),
		);
		await browser.close();
		await fixture.kill();
		const moved = `${fixture.projectDir}.moved`;
		renameSync(fixture.projectDir, moved);
		await fixture.restart({ skipBrowserProbe: true });
		// test-waits-allow real-wait: a window for startup recovery to act on the missing folder; nothing marks it.
		await new Promise((done) => setTimeout(done, 3_000));
		const whileGone = store(fixture, sessionId);
		evidence["folderGone"] = {
			runner: {
				before: pid,
				alive: (() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				})(),
			},
			whileGone: whileGone.sends.map(({ status, error_code }) => ({
				status,
				error: error_code,
			})),
		};
		expect(() => process.kill(pid, 0)).not.toThrow();
		expect(whileGone.sends.map(({ status }) => status)).not.toContain("failed");
		expect(enqueued("queued-while-gone")).toBe(0);

		renameSync(moved, fixture.projectDir);
		const returned = await fixture.connect(sessionId);
		await returned.view(sessionId);
		writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
		// test-waits-allow polling: durable run state and the fake SDK's proof file have no event.
		await vi.waitFor(
			() => {
				expect(store(fixture, sessionId).busy).toBe(false);
				expect(enqueued("queued-while-gone")).toBe(1);
			},
			{ timeout: 60_000 },
		);
		const after = store(fixture, sessionId);
		(evidence["folderGone"] as Record<string, unknown>)["afterReturn"] = {
			runners: [
				...new Set(
					fixture.marks.flatMap((mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId
							? [mark.pid]
							: [],
					),
				),
			],
			sends: after.sends.map(({ status, receipt }) => ({ status, receipt })),
		};
		expect(enqueued("upgrade-long-turn")).toBe(1);
		expect(after.sends.map(({ status }) => status)).toEqual([
			"completed",
			"completed",
		]);
		expect(new Set(after.receipts).size).toBe(after.receipts.length);
	}, 180_000);

	// test-waits-allow timeout-override: daemon restarts with several runners exceed the 30 s default.
	it("deletes a session whose runner is being adopted without disturbing another adopted turn", async () => {
		const { fixture, browser, ids, enqueued, runner } = await heldClaude([
			"Deleted at startup",
			"Kept at startup",
		]);
		const [deleted = "", kept = ""] = ids;
		const deletedPid = runner(deleted);
		const keptPid = runner(kept);
		await browser.close();
		await fixture.kill();
		await fixture.restart({ skipBrowserProbe: true });
		const early = await fixture.connect();
		await early.deleteSession(deleted);
		// test-waits-allow polling: a runner process exit has no event.
		await vi.waitFor(
			() => expect(() => process.kill(deletedPid, 0)).toThrow(),
			{
				timeout: 30_000,
			},
		);
		expect(() => process.kill(keptPid, 0)).not.toThrow();
		await early.view(kept);
		writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
		// test-waits-allow polling: durable run state has no event.
		await vi.waitFor(() => expect(store(fixture, kept).busy).toBe(false), {
			timeout: 30_000,
		});
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		const remaining = db
			.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?")
			.get(deleted) as { n: number };
		db.close();
		evidence["deleteDuringAdoption"] = {
			deletedRunnerExited: true,
			keptRunnerAdopted: keptPid,
			deletedRows: remaining.n,
			kept: store(fixture, kept).sends.map(({ status, receipt }) => ({
				status,
				receipt,
			})),
		};
		expect(remaining.n).toBe(0);
		expect(enqueued("upgrade-long-turn")).toBe(2);
		expect(store(fixture, kept).sends.map(({ status }) => status)).toEqual([
			"completed",
		]);
	}, 180_000);
});
