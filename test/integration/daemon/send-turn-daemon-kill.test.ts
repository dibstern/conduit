import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MANAGED_OPENCODE_ACCOUNT_ID } from "../../../src/lib/contracts/provider-instance.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const cases = [
	{ provider: "claude", survives: true, echoed: true },
	{ provider: "claude", survives: false, echoed: true },
	{ provider: "opencode", survives: true, echoed: true },
	{ provider: "opencode", survives: false, echoed: true },
	{ provider: "opencode", survives: false, echoed: false },
] as const;

function openCodeHistory(
	sessionId: string,
	userId: string,
	created: number,
	completed: boolean,
) {
	const assistantId = `msg_reply_${userId}`;
	const part = (messageID: string, text: string) => ({
		id: `prt_${messageID}`,
		sessionID: sessionId,
		messageID,
		type: "text",
		text,
	});
	return [
		{
			info: {
				id: userId,
				sessionID: sessionId,
				role: "user",
				time: { created },
				agent: "build",
				model: { providerID: "fake", modelID: "fake-model" },
			},
			parts: [part(userId, "recovery history prompt")],
		},
		{
			info: {
				id: assistantId,
				sessionID: sessionId,
				role: "assistant",
				parentID: userId,
				time: {
					created: created + 1,
					...(completed ? { completed: created + 2 } : {}),
				},
				modelID: "fake-model",
				providerID: "fake",
				mode: "build",
				agent: "build",
				path: { cwd: "/", root: "/" },
				cost: 0,
				tokens: {
					input: 1,
					output: 1,
					reasoning: 0,
					cache: { read: 0, write: 0 },
				},
				...(completed ? { finish: "stop" } : {}),
			},
			parts: [
				part(
					assistantId,
					completed ? "Finished during downtime" : "Unfinished during downtime",
				),
			],
		},
	];
}

function snapshot(fixture: ProcessHarness, sessionId: string, prompt: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		const outbox = db
			.prepare(`SELECT command_id, status, error_code
			FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'
			ORDER BY request_sequence`)
			.all(sessionId) as Array<{
			command_id: string;
			status: string;
			error_code: string | null;
		}>;
		const turns = db
			.prepare(`SELECT id, state FROM turns WHERE session_id = ?
			ORDER BY requested_at, rowid`)
			.all(sessionId) as Array<{ id: string; state: string }>;
		// Read the inbox's durable run status, including an unacknowledged send.
		const facts = db
			.prepare(`SELECT status,
			EXISTS (SELECT 1 FROM provider_runs WHERE session_id = @id
				AND status IN ('pending', 'running')) AS run_busy,
			EXISTS (SELECT 1 FROM provider_command_outbox outbox
				JOIN pending_inputs pending ON pending.input_id = outbox.command_id
				WHERE outbox.session_id = @id AND outbox.effect_type = 'send_turn'
				AND outbox.status IN ('pending', 'running', 'retryable_failed')
				AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.input_id = outbox.command_id)) AS in_flight
			FROM sessions WHERE id = @id`)
			.get({ id: sessionId }) as {
			status: string;
			run_busy: number;
			in_flight: number;
		};
		const provider = db
			.prepare("SELECT provider FROM sessions WHERE id = ?")
			.get(sessionId) as { provider: string };
		const providerPromptCount =
			provider.provider === MANAGED_OPENCODE_ACCOUNT_ID
				? fixture
						.opencodeRequestBodies()
						.filter(
							({ method, path, body }) =>
								method === "POST" &&
								path === `/session/${sessionId}/prompt_async` &&
								body.includes(prompt),
						).length
				: readFileSync(join(fixture.root, "sdk-proof.ndjson"), "utf8")
						.trim()
						.split("\n")
						.map(
							(line) => JSON.parse(line) as { kind: string; request?: string },
						)
						.filter(
							(mark) => mark.kind === "enqueue" && mark.request === prompt,
						).length;
		return {
			outbox,
			inbox: {
				busy: facts.run_busy === 1,
				in_flight: facts.in_flight === 1,
			},
			turns,
			sessionStatus: facts.status,
			providerPromptCount,
		};
	} finally {
		db.close();
	}
}

// Failure modes: startup re-sends the prompt; an orphan stays running and pins
// the inbox; recovery interrupts a live turn; a lost turn silently completes;
// or a recovered reply/terminal event never reaches browser history.
describe("a send claimed before daemon SIGKILL", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Array<Record<string, unknown>> = [];
	async function startOpenCodeTurn(echoed: boolean) {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		harness = fixture;
		await fixture.restart({ opencodeIdleTimeoutMs: 120_000 });
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"History recovery",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
		const inputId = randomUUID();
		const prompt = "recovery history prompt";
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: prompt,
			}),
		);
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, sessionId, prompt).providerPromptCount).toBe(
					1,
				),
			{ timeout: 15_000 },
		);
		const body = JSON.parse(
			fixture
				.opencodeRequestBodies()
				.find(({ path }) => path === `/session/${sessionId}/prompt_async`)
				?.body ?? "{}",
		) as { messageID?: string };
		const userId = body.messageID ?? `msg_${randomUUID()}`;
		const created = Date.now();
		const directory = realpathSync(fixture.projectDir);
		const history = openCodeHistory(sessionId, userId, created, false);
		if (echoed) {
			for (const message of history) {
				await fixture.emitOpenCodeEvent({
					directory,
					payload: {
						id: randomUUID(),
						type: "message.updated",
						properties: { info: message.info },
					},
				});
				for (const part of message.parts)
					await fixture.emitOpenCodeEvent({
						directory,
						payload: {
							id: randomUUID(),
							type: "message.part.updated",
							properties: { part },
						},
					});
			}
			await vi.waitFor(() =>
				expect(
					snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
				).toEqual(["running"]),
			);
		}
		return {
			fixture,
			browser,
			sessionId,
			inputId,
			userId,
			created,
			directory,
			prompt,
		};
	}
	afterEach(async () => {
		try {
			await harness?.dispose();
			harness?.assertNoRunners();
		} finally {
			harness = undefined;
			const ids = new Map<string, string>();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn23-daemon-kill.json",
				`${JSON.stringify(
					proofs,
					(key, value: unknown) => {
						if (
							["sessionId", "command_id", "input_id", "id"].includes(key) &&
							typeof value === "string"
						) {
							if (!ids.has(value)) ids.set(value, `id-${ids.size + 1}`);
							return ids.get(value);
						}
						return value;
					},
					2,
				)}\n`,
			);
		}
	});

	it.each(
		cases,
	)("$provider, upstream survives=$survives, echoed=$echoed", async ({
		provider,
		survives,
		echoed,
	}) => {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			restartProof: true,
			autoStartOpenCode: provider === "opencode",
		});
		harness = fixture;
		await fixture.restart({ opencodeIdleTimeoutMs: 120_000 });
		let browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Daemon kill",
			provider === "opencode" ? MANAGED_OPENCODE_ACCOUNT_ID : "claude",
			provider,
		);
		const prompt =
			provider === "claude" ? "upgrade-long-turn" : "daemon-kill-turn";
		const proof: Record<string, unknown> = {
			provider,
			survives,
			echoed,
			sessionId,
		};
		proofs.push(proof);
		const directory = realpathSync(fixture.projectDir);
		const userId = `msg_${randomUUID()}`;
		const assistantId = "msg_daemon_kill_reply";
		const created = Date.now();
		const emit = (type: string, properties: unknown) =>
			fixture.emitOpenCodeEvent({
				directory,
				payload: { id: `evt_${randomUUID()}`, type, properties },
			});
		const assistant = (completed: boolean) =>
			emit("message.updated", {
				info: {
					id: assistantId,
					sessionID: sessionId,
					role: "assistant",
					parentID: userId,
					time: { created, ...(completed && { completed: Date.now() }) },
					...(completed && { finish: "stop" }),
				},
			});
		const text = (value: string) =>
			emit("message.part.updated", {
				part: {
					id: "prt_daemon_kill",
					sessionID: sessionId,
					messageID: assistantId,
					type: "text",
					text: value,
				},
			});
		if (provider === "opencode")
			writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
		const inputId = randomUUID();
		if (!echoed)
			await fixture.dropOpenCodeEvents([
				{ type: "session.status", status: "busy" },
			]);
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: prompt,
			}),
		);
		if (provider === "opencode") {
			await vi.waitFor(() =>
				expect(
					fixture
						.opencodeRequestBodies()
						.some(({ path }) => path === `/session/${sessionId}/prompt_async`),
				).toBe(true),
			);
			if (echoed) {
				await emit("message.updated", {
					info: {
						id: userId,
						sessionID: sessionId,
						role: "user",
						time: { created },
					},
				});
				await assistant(false);
				await text("Still running");
			}
		}
		await vi.waitFor(
			async () => {
				const state = snapshot(fixture, sessionId, prompt);
				expect(state.outbox.map(({ status }) => status)).toEqual(["running"]);
				expect(state.turns.map(({ state }) => state)).toEqual(
					echoed ? ["running"] : [],
				);
				expect(state.inbox.busy).toBe(true);
				if (!echoed) {
					expect(state.sessionStatus).toBe("idle");
					expect(state.inbox.in_flight).toBe(true);
				}
				expect(state.providerPromptCount).toBe(1);
				const history = await browser.history(sessionId);
				expect(
					history.some(
						(message) =>
							message.role === "assistant" &&
							message.parts?.some(
								(part) => part.type === "text" && Boolean(part.text),
							),
					),
				).toBe(echoed);
			},
			{ timeout: 15_000 },
		);
		proof["before"] = snapshot(fixture, sessionId, prompt);
		const openCodePid =
			provider === "opencode"
				? fixture.opencodeRequests().at(-1)?.pid
				: undefined;
		await fixture.kill();
		if (provider === "claude") {
			const runner = fixture.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			if (runner?.kind !== "runner-started")
				throw new Error("Missing runner PID");
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			if (!survives) {
				process.kill(runner.pid, "SIGKILL");
				await vi.waitFor(() =>
					expect(() => process.kill(runner.pid, 0)).toThrow(),
				);
			}
		} else if (!survives) {
			// The upstream run disappears while the daemon cannot observe it.
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			writeFileSync(
				join(fixture.configDir, "fake-opencode-history-failures.json"),
				JSON.stringify({ [sessionId]: "not-found" }),
			);
		}
		await fixture.restart({ skipBrowserProbe: true });
		if (provider === "opencode") {
			if (!openCodePid) throw new Error("Missing OpenCode PID");
			expect(() => process.kill(openCodePid, 0)).not.toThrow();
		}
		if (survives) {
			// An adopted active run must retain its running turn until upstream ends.
			expect(
				snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
			).toEqual(["running"]);
			if (provider === "claude")
				writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
			else {
				await emit("message.part.delta", {
					sessionID: sessionId,
					messageID: assistantId,
					partID: "prt_daemon_kill",
					field: "text",
					delta: "; finished after restart",
				});
				await assistant(true);
				await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			}
		}
		try {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.outbox).toHaveLength(1);
					expect(["completed", "failed"]).toContain(state.outbox[0]?.status);
					expect(state.turns).toHaveLength(echoed ? 1 : 0);
					if (echoed)
						expect(
							survives ? ["completed"] : ["error", "interrupted"],
						).toContain(state.turns[0]?.state);
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
		// Recovery must settle without a browser action acquiring the relay.
		browser = await fixture.connect(sessionId);
		const history = await browser.history(sessionId);
		if (survives) {
			const reply = history
				.filter((message) => message.role === "assistant")
				.flatMap((message) =>
					(message.parts ?? [])
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? ""),
				)
				.join("");
			expect(reply).toBe(
				provider === "claude"
					? responseChunks(prompt).join("")
					: "Still running; finished after restart",
			);
		} else {
			expect(
				history.some((message) =>
					message.parts?.some((part) => part.type === "error"),
				),
			).toBe(true);
		}
	}, 60_000);

	it.each([
		"retry",
		"restart",
	])("settles an unechoed stranded steer and retries publication after %s", async (recovery) => {
		const fixture = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			logLevel: "warn",
		});
		harness = fixture;
		await fixture.restart({ opencodeIdleTimeoutMs: 120_000 });
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Stranded steer",
			MANAGED_OPENCODE_ACCOUNT_ID,
			"opencode",
		);
		writeFileSync(join(fixture.configDir, "fake-opencode-hold-turn"), "hold");
		const inputId = randomUUID();
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId,
				delivery: "queue",
				text: "stranded steer",
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, sessionId, "stranded steer").providerPromptCount,
				).toBe(1),
			{ timeout: 15_000 },
		);
		const proof: Record<string, unknown> = {
			case: "stranded steer",
			recovery,
			sessionId,
			before: snapshot(fixture, sessionId, "stranded steer"),
		};
		proofs.push(proof);
		await fixture.kill();
		// OpenCode currently queues new busy inputs. Preserve the legacy
		// stranded-steer shape that restart recovery still has to handle.
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare(
				"UPDATE pending_inputs SET state = 'steering' WHERE input_id = ?",
			).run(inputId);
			db.prepare(
				"UPDATE events SET data = json_set(data, '$.steer', json('true')) WHERE session_id = ? AND type = 'input.sent' AND json_extract(data, '$.inputId') = ?",
			).run(sessionId, inputId);
			db.exec(
				"CREATE TRIGGER fail_requeue BEFORE INSERT ON events WHEN NEW.type = 'input.requeued' BEGIN SELECT RAISE(ABORT, 'injected requeue publication failure'); END",
			);
		} finally {
			db.close();
		}
		await fixture.setOpenCodeStatus(
			realpathSync(fixture.projectDir),
			sessionId,
			{
				type: "idle",
			},
		);
		await fixture.restart({ skipBrowserProbe: true });
		try {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, "stranded steer");
					expect(state.outbox.map(({ status }) => status)).toEqual(["failed"]);
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
			if (recovery === "restart") {
				await fixture.kill();
				const foreign = new Database(fixture.daemonStorePath());
				try {
					foreign
						.prepare(
							"INSERT INTO sessions (id, provider, project_id, created_at, updated_at) VALUES ('foreign-session', ?, 'another-project', 1, 1)",
						)
						.run(MANAGED_OPENCODE_ACCOUNT_ID);
					foreign.exec(`
						INSERT INTO pending_inputs (input_id, session_id, text, request, state, admitted_at, version)
						VALUES ('foreign-input', 'foreign-session', 'foreign steer', '{}', 'steering', 1, 1);
						INSERT INTO events (event_id, session_id, stream_version, type, data, provider, created_at, project_id)
						VALUES ('foreign-sent', 'foreign-session', 1, 'input.sent', '{"inputId":"foreign-input","sessionId":"foreign-session","steer":true}', 'conduit', 1, 'another-project');
						INSERT INTO provider_command_outbox (command_id, project_key, session_id, provider_id, effect_type, payload_json, status, requested_at, updated_at)
						VALUES ('foreign-input', 'another-project', 'foreign-session', 'opencode', 'send_turn', '{}', 'failed', 1, 1);
					`);
				} finally {
					foreign.close();
				}
				await fixture.restart({ skipBrowserProbe: true });
				await vi.waitFor(
					() => expect(fixture.logTail).toContain("inbox recovery failed"),
					{ timeout: 15_000 },
				);
			}
			const release = new Database(fixture.daemonStorePath());
			try {
				release.exec("DROP TRIGGER fail_requeue");
			} finally {
				release.close();
			}
			await vi.waitFor(
				() => {
					const read = new Database(fixture.daemonStorePath(), {
						readonly: true,
					});
					try {
						expect(
							read
								.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
								.get(inputId),
						).toEqual({ state: "queued" });
						expect(
							read
								.prepare(
									"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'input.requeued'",
								)
								.get(sessionId),
						).toEqual({ n: 1 });
						if (recovery === "restart")
							expect(
								read
									.prepare(
										"SELECT state FROM pending_inputs WHERE input_id = 'foreign-input'",
									)
									.get(),
							).toEqual({ state: "steering" });
						expect(
							read
								.prepare(
									"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'turn.error'",
								)
								.get(sessionId),
						).toEqual({ n: 1 });
					} finally {
						read.close();
					}
				},
				{ timeout: 15_000 },
			);
			// A second recovery must neither re-send the paused steer nor undo it.
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(
				snapshot(fixture, sessionId, "stranded steer").outbox.map(
					({ status }) => status,
				),
			).toEqual(["failed"]);
			expect(
				snapshot(fixture, sessionId, "stranded steer").providerPromptCount,
			).toBe(1);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, "stranded steer");
		}
	}, 60_000);

	it.each([
		{ echoed: true, completed: true, steer: false },
		{ echoed: false, completed: false, steer: false },
		{ echoed: false, completed: true, steer: true },
	])("recovers REST history after downtime, echo=$echoed, completed=$completed, steer=$steer", async ({
		echoed,
		completed,
		steer,
	}) => {
		const { fixture, sessionId, inputId, userId, created, directory, prompt } =
			await startOpenCodeTurn(echoed);
		const proof: Record<string, unknown> = {
			case: completed
				? steer
					? "completed unechoed steer"
					: "finished while down"
				: "lost echo with unfinished history",
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		await fixture.kill();
		if (steer) {
			const db = new Database(fixture.daemonStorePath());
			try {
				db.prepare(
					"UPDATE pending_inputs SET state = 'steering' WHERE input_id = ?",
				).run(inputId);
				db.prepare(
					"UPDATE events SET data = json_set(data, '$.steer', json('true')) WHERE session_id = ? AND type = 'input.sent' AND json_extract(data, '$.inputId') = ?",
				).run(sessionId, inputId);
			} finally {
				db.close();
			}
		}
		writeFileSync(
			join(fixture.configDir, "fake-opencode-history.json"),
			JSON.stringify({
				[sessionId]: openCodeHistory(sessionId, userId, created, completed),
			}),
		);
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await fixture.restart({ skipBrowserProbe: true });
		try {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox.map(({ status }) => status)).toEqual([
						completed ? "completed" : "failed",
					]);
					expect(state.turns.map(({ state }) => state)).toEqual([
						completed ? "completed" : "error",
					]);
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
					const db = new Database(fixture.daemonStorePath(), {
						readonly: true,
					});
					try {
						expect(
							db
								.prepare("SELECT state FROM pending_inputs WHERE input_id = ?")
								.get(inputId),
						).toEqual({ state: "removed" });
					} finally {
						db.close();
					}
				},
				{ timeout: 15_000 },
			);
			const browser = await fixture.connect(sessionId);
			const history = await browser.history(sessionId);
			expect(
				history.some((message) =>
					message.parts?.some((part) => part.type === "error"),
				),
			).toBe(!completed);
			if (completed)
				expect(
					history.some((message) =>
						message.parts?.some(
							(part) => part.text === "Finished during downtime",
						),
					),
				).toBe(true);
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(
				snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
			).toEqual([completed ? "completed" : "error"]);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 60_000);

	it.each([
		{ state: "running", owned: true },
		{ state: "pending", owned: false },
	])("checks unrelated $state turns before projecting recovery idle", async ({
		state: unrelatedState,
		owned,
	}) => {
		const { fixture, sessionId, directory, prompt } =
			await startOpenCodeTurn(true);
		await fixture.kill();
		const unrelatedId = `msg_unrelated_${randomUUID()}`;
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare(`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
				VALUES (?, ?, ?, ?, (SELECT MAX(requested_at) + 1 FROM turns WHERE session_id = ?))`).run(
				unrelatedId,
				sessionId,
				unrelatedState,
				owned ? unrelatedId : null,
				sessionId,
			);
		} finally {
			db.close();
		}
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		const hold = join(fixture.configDir, "fake-opencode-hold-history");
		writeFileSync(hold, "hold");
		const proof: Record<string, unknown> = {
			case: `unrelated ${unrelatedState} turn before idle projection`,
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		await fixture.restart({ skipBrowserProbe: true });
		try {
			await vi.waitFor(
				() =>
					expect(
						existsSync(
							join(fixture.configDir, "fake-opencode-held-history.jsonl"),
						),
					).toBe(true),
				{ timeout: 15_000 },
			);
			// Let startup consume its idle sample, while subsequent reconciles
			// see busy. No SSE invalidates the sample: the durable turn is the fence.
			await fixture.dropOpenCodeEvents([
				{ type: "session.status", status: "busy" },
			]);
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "busy" });
			rmSync(hold);
			await fixture.connect(sessionId);
			proof["protected"] = snapshot(fixture, sessionId, prompt);
			expect(
				snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
			).toEqual(["running", unrelatedState]);
			expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
				"running",
			);
			// Restart during deferred recovery, then retire only the unrelated run.
			await fixture.kill();
			const settled = new Database(fixture.daemonStorePath());
			try {
				settled
					.prepare("UPDATE turns SET state = 'interrupted' WHERE id = ?")
					.run(unrelatedId);
			} finally {
				settled.close();
			}
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			await fixture.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox[0]?.status).toBe("failed");
					expect(state.turns.find(({ id }) => id === unrelatedId)?.state).toBe(
						"interrupted",
					);
					expect(
						state.turns
							.filter(({ id }) => id !== unrelatedId)
							.map(({ state }) => state),
					).toEqual(["error"]);
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
		} finally {
			rmSync(hold, { force: true });
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 60_000);

	it("settles an unechoed send when its managed OpenCode process died too", async () => {
		const { fixture, sessionId, prompt } = await startOpenCodeTurn(false);
		const pidsFile = join(fixture.configDir, "fake-opencode-pids.jsonl");
		const processes = readFileSync(pidsFile, "utf8").trim().split("\n");
		const { groupPid } = JSON.parse(processes.at(-1) ?? "{}") as {
			groupPid: number;
		};
		expect(groupPid).toBeGreaterThan(1);
		const proof: Record<string, unknown> = {
			case: "managed OpenCode process gone without echo",
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		await fixture.kill();
		process.kill(-groupPid, "SIGKILL");
		await vi.waitFor(() => expect(() => process.kill(groupPid, 0)).toThrow());
		await fixture.restart({ skipBrowserProbe: true });
		try {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox[0]?.status).toBe("failed");
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
			const browser = await fixture.connect(sessionId);
			expect(
				(await browser.history(sessionId)).some((message) =>
					message.parts?.some(
						(part) =>
							part.type === "error" && part.text?.includes("not re-sent"),
					),
				),
			).toBe(true);
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(snapshot(fixture, sessionId, prompt).inbox.busy).toBe(false);
			expect(readFileSync(pidsFile, "utf8").trim().split("\n")).toEqual(
				processes,
			);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 60_000);

	it.each([
		"recorded",
		"missing",
	])("defers an orphan while managed OpenCode is unhealthy with %s process identity", async (identity) => {
		const { fixture, sessionId, directory, prompt } =
			await startOpenCodeTurn(false);
		const pidsFile = join(fixture.configDir, "fake-opencode-pids.jsonl");
		const processes = readFileSync(pidsFile, "utf8");
		const hold = join(fixture.configDir, "fake-opencode-hold-health");
		await fixture.kill();
		const configPath = join(fixture.configDir, "daemon.json");
		const savedConfig = readFileSync(configPath, "utf8");
		if (identity === "missing") {
			const config = JSON.parse(savedConfig) as {
				instances: Array<Record<string, unknown>>;
			};
			config.instances = config.instances.map(
				({ pid: _pid, processIdentity: _identity, ...instance }) => instance,
			);
			writeFileSync(configPath, JSON.stringify(config));
		}
		writeFileSync(hold, "hold");
		const proof: Record<string, unknown> = {
			case: `managed OpenCode unhealthy with ${identity} process identity`,
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		try {
			await fixture.restart({ skipBrowserProbe: true });
			await fixture.connect(sessionId);
			proof["unavailable"] = snapshot(fixture, sessionId, prompt);
			expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
				"running",
			);
			expect(snapshot(fixture, sessionId, prompt).inbox).toEqual({
				busy: true,
				in_flight: true,
			});
			expect(readFileSync(pidsFile, "utf8")).toBe(processes);
			await fixture.kill();
			writeFileSync(configPath, savedConfig);
			rmSync(hold);
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			await fixture.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox[0]?.status).toBe("failed");
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
			expect(readFileSync(pidsFile, "utf8")).toBe(processes);
		} finally {
			rmSync(hold, { force: true });
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 60_000);

	it.each([
		404, 503,
	])("defers an orphan while the status endpoint returns HTTP %s", async (status) => {
		const { fixture, sessionId, directory, prompt } =
			await startOpenCodeTurn(false);
		await fixture.kill();
		const failure = join(fixture.configDir, "fake-opencode-status-failure");
		writeFileSync(failure, String(status));
		const recoveryLog = join(fixture.configDir, "daemon.log");
		const recoveryFailures = () =>
			existsSync(recoveryLog)
				? readFileSync(recoveryLog, "utf8").split(
						"OpenCode send recovery deferred",
					).length - 1
				: 0;
		const previousFailures = recoveryFailures();
		const proof: Record<string, unknown> = {
			case: `status endpoint HTTP ${status}`,
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		try {
			await fixture.restart({ skipBrowserProbe: true });
			await fixture.connect(undefined, undefined, "process-test", false);
			// Observe the recovery attempt's outcome before checking its row.
			await vi.waitFor(
				() =>
					expect(
						recoveryFailures() > previousFailures ||
							snapshot(fixture, sessionId, prompt).outbox[0]?.status !==
								"running",
					).toBe(true),
				{ timeout: 15_000 },
			);
			proof["unavailable"] = snapshot(fixture, sessionId, prompt);
			expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
				"running",
			);
			expect(snapshot(fixture, sessionId, prompt).inbox).toEqual({
				busy: true,
				in_flight: true,
			});
			expect(snapshot(fixture, sessionId, prompt).providerPromptCount).toBe(1);
			await fixture.kill();
			rmSync(failure);
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			await fixture.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox[0]?.status).toBe("failed");
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
		} finally {
			rmSync(failure, { force: true });
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 60_000);

	it.each([
		"completed",
		"failed",
	])("clears stale busy when a newer send is already %s", async (status) => {
		const { fixture, sessionId, directory, prompt } =
			await startOpenCodeTurn(true);
		await fixture.kill();
		const db = new Database(fixture.daemonStorePath());
		try {
			// A later command's receipt already committed; only the older send
			// and stale session busy survived the crash. No other turn is open.
			db.prepare(`INSERT INTO provider_command_outbox
				(command_id, project_key, session_id, provider_id, effect_type, run_id, payload_json,
				status, attempt_count, requested_at, updated_at)
				SELECT ?, project_key, session_id, provider_id, effect_type, run_id, payload_json, ?,
				attempt_count, requested_at, updated_at FROM provider_command_outbox WHERE session_id = ?`).run(
				randomUUID(),
				status,
				sessionId,
			);
		} finally {
			db.close();
		}
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		const proof: Record<string, unknown> = {
			case: `newer ${status} command with stale busy`,
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		await fixture.restart({ skipBrowserProbe: true });
		try {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox.map(({ status }) => status)).toEqual([
						"failed",
						status,
					]);
					expect(state.turns.map(({ state }) => state)).toEqual(["error"]);
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(snapshot(fixture, sessionId, prompt).inbox.busy).toBe(false);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 60_000);

	it.each([
		false,
		true,
	])("preserves a newer running turn in its stored directory, stale native directory=%s", async (staleNativeDirectory) => {
		const { fixture, browser, sessionId, userId, created, directory, prompt } =
			await startOpenCodeTurn(true);
		const finished = openCodeHistory(sessionId, userId, created, true);
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: { info: finished[1]?.info },
			},
		});
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
					"completed",
				),
			{ timeout: 15_000 },
		);
		const nextInputId = randomUUID();
		const nextPrompt = "newer moved turn";
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: nextInputId,
				delivery: "queue",
				text: nextPrompt,
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, sessionId, nextPrompt).providerPromptCount,
				).toBe(1),
			{ timeout: 15_000 },
		);
		const request = JSON.parse(
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => path === `/session/${sessionId}/prompt_async`)
				.at(-1)?.body ?? "{}",
		) as { messageID?: string };
		const nextUserId = request.messageID ?? `msg_${randomUUID()}`;
		const nextCreated = Date.now();
		const nextHistory = openCodeHistory(
			sessionId,
			nextUserId,
			nextCreated,
			false,
		);
		for (const message of nextHistory)
			await fixture.emitOpenCodeEvent({
				directory,
				payload: {
					id: randomUUID(),
					type: "message.updated",
					properties: { info: message.info },
				},
			});
		await vi.waitFor(() =>
			expect(
				snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
			).toEqual(["completed", "running"]),
		);
		await fixture.kill();
		// The earlier run ended atomically. Only the newer send is outstanding,
		// and its persisted directory must govern recovery after the move.
		const movedDirectory = join(directory, "moved");
		mkdirSync(movedDirectory);
		const db = new Database(fixture.daemonStorePath());
		try {
			db.prepare(
				"UPDATE provider_command_outbox SET payload_json = json_set(payload_json, '$.workspaceRoot', ?) WHERE session_id = ? AND command_id = ?",
			).run(movedDirectory, sessionId, nextInputId);
			db.prepare("UPDATE sessions SET workspace = ? WHERE id = ?").run(
				JSON.stringify({
					cause: "user",
					origin: "existing",
					worktrees: { [directory]: movedDirectory },
				}),
				sessionId,
			);
		} finally {
			db.close();
		}
		const sessionFile = join(fixture.configDir, "fake-opencode-sessions.json");
		const sessions = JSON.parse(readFileSync(sessionFile, "utf8")) as Array<{
			id: string;
			directory: string;
		}>;
		writeFileSync(
			sessionFile,
			JSON.stringify(
				sessions.map((session) =>
					session.id === sessionId && !staleNativeDirectory
						? { ...session, directory: movedDirectory }
						: session,
				),
			),
		);
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await fixture.setOpenCodeStatus(movedDirectory, sessionId, {
			type: "busy",
		});
		const proof: Record<string, unknown> = {
			case: staleNativeDirectory
				? "moved newer turn with stale native directory"
				: "moved newer turn",
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		await fixture.restart({ skipBrowserProbe: true });
		try {
			// Wait for a recovery attempt, then prove it did not close the new turn.
			await vi.waitFor(
				() =>
					expect(
						fixture
							.opencodeRequests()
							.some(
								({ url, directory: scope }) =>
									url.startsWith("/session/status") &&
									(new URL(url, fixture.baseUrl).searchParams.get(
										"directory",
									) ?? scope) === movedDirectory,
							),
					).toBe(true),
				{ timeout: 15_000 },
			);
			expect(
				snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
			).toEqual(["completed", "running"]);
			expect(snapshot(fixture, sessionId, prompt).inbox.busy).toBe(true);
			expect(
				snapshot(fixture, sessionId, prompt).outbox.map(({ status }) => status),
			).toEqual(["completed", "running"]);
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(
				snapshot(fixture, sessionId, prompt).turns.map(({ state }) => state),
			).toEqual(["completed", "running"]);
			// The second run then finishes upstream. Preserve both replies and
			// the earlier completed command without re-sending either input.
			await fixture.kill();
			writeFileSync(
				join(fixture.configDir, "fake-opencode-history.json"),
				JSON.stringify({
					[sessionId]: [
						...finished,
						...openCodeHistory(sessionId, nextUserId, nextCreated, true),
					],
				}),
			);
			await fixture.setOpenCodeStatus(movedDirectory, sessionId, {
				type: "idle",
			});
			await fixture.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox.map(({ status }) => status)).toEqual([
						"completed",
						"completed",
					]);
					expect(state.turns.map(({ state }) => state)).toEqual([
						"completed",
						"completed",
					]);
					expect(state.inbox.busy).toBe(false);
					expect(state.providerPromptCount).toBe(1);
					expect(
						snapshot(fixture, sessionId, nextPrompt).providerPromptCount,
					).toBe(1);
				},
				{ timeout: 15_000 },
			);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 90_000);

	it("recovers the owned run before sending queued work", async () => {
		const { fixture, sessionId, inputId, userId, created, directory, prompt } =
			await startOpenCodeTurn(false);
		const finished = openCodeHistory(sessionId, userId, created, true);
		// Lose intake and terminal events while the reservation is pending and
		// the command is running. Recovery must obtain its exact native history.
		await fixture.kill();
		expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
			"running",
		);
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		const failures = join(
			fixture.configDir,
			"fake-opencode-history-failures.json",
		);
		writeFileSync(failures, JSON.stringify({ [sessionId]: true }));
		writeFileSync(
			join(fixture.configDir, "fake-opencode-history.json"),
			JSON.stringify({ [sessionId]: finished }),
		);
		await fixture.restart({ skipBrowserProbe: true });
		// Selecting the session would start an ordinary detail backfill as well.
		const after = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const hold = join(fixture.configDir, "fake-opencode-hold-history");
		writeFileSync(hold, "hold");
		writeFileSync(failures, "{}");
		const held = join(fixture.configDir, "fake-opencode-held-history.jsonl");
		await vi.waitFor(() => expect(existsSync(held)).toBe(true), {
			timeout: 20_000,
		});
		const nextPrompt = "queued during recovery";
		const nextInputId = randomUUID();
		const proof: Record<string, unknown> = {
			case: "owned recovery before queued send",
			outcome: "failed",
			sessionId,
			before: snapshot(fixture, sessionId, prompt),
		};
		proofs.push(proof);
		try {
			const admission = await Effect.runPromise(
				after.rpc["input.submit"]({
					sessionId,
					originId: after.originId,
					inputId: nextInputId,
					delivery: "queue",
					text: nextPrompt,
				}),
			);
			expect(admission).toEqual({ ok: true, sessionId, handedOff: false });
			expect(snapshot(fixture, sessionId, nextPrompt).providerPromptCount).toBe(
				0,
			);
			expect(
				snapshot(fixture, sessionId, prompt).outbox.map(({ status }) => status),
			).toEqual(["running"]);
			proof["queuedWithoutHandoff"] = true;
			rmSync(hold);
			await vi.waitFor(
				() => {
					expect(
						snapshot(fixture, sessionId, nextPrompt).providerPromptCount,
					).toBe(1);
					expect(
						snapshot(fixture, sessionId, prompt).outbox.map(
							({ status }) => status,
						),
					).toEqual(["completed", "running"]);
				},
				{ timeout: 15_000 },
			);
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				const ordered = db
					.prepare(`SELECT
					(SELECT MIN(sequence) FROM events WHERE session_id = @sessionId AND type = 'session.status'
					 AND json_extract(data, '$.status') = 'idle' AND json_extract(metadata, '$.runId') =
					 (SELECT run_id FROM provider_command_outbox WHERE command_id = @inputId)) AS ended,
					(SELECT MIN(sequence) FROM events WHERE session_id = @sessionId AND type = 'run.requested'
					 AND json_extract(data, '$.inputId') = @nextInputId) AS requested`)
					.get({ sessionId, inputId, nextInputId }) as {
					ended: number;
					requested: number;
				};
				expect(ordered.ended).toBeGreaterThan(0);
				expect(ordered.ended).toBeLessThan(ordered.requested);
			} finally {
				db.close();
			}
			proof["recoveredBeforeQueuedSend"] = true;
			const request = JSON.parse(
				fixture
					.opencodeRequestBodies()
					.filter(({ path }) => path === `/session/${sessionId}/prompt_async`)
					.at(-1)?.body ?? "{}",
			) as { messageID?: string };
			if (!request.messageID)
				throw new Error("New sends must reserve their native user message ID");
			const nextUserId = request.messageID;
			expect(
				snapshot(fixture, sessionId, prompt).outbox.map(({ status }) => status),
			).toEqual(["completed", "running"]);
			expect(snapshot(fixture, sessionId, prompt).inbox.busy).toBe(true);
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(
				snapshot(fixture, sessionId, prompt).outbox.map(({ status }) => status),
			).toEqual(["completed", "running"]);
			expect(snapshot(fixture, sessionId, nextPrompt).providerPromptCount).toBe(
				1,
			);
			await fixture.kill();
			writeFileSync(
				join(fixture.configDir, "fake-opencode-history.json"),
				JSON.stringify({
					[sessionId]: [
						...finished,
						...openCodeHistory(sessionId, nextUserId, Date.now(), true),
					],
				}),
			);
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			await fixture.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, prompt);
					expect(state.outbox.map(({ status }) => status)).toEqual([
						"completed",
						"completed",
					]);
					expect(state.turns.map(({ state }) => state)).toEqual([
						"completed",
						"completed",
					]);
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
					expect(
						snapshot(fixture, sessionId, nextPrompt).providerPromptCount,
					).toBe(1);
				},
				{ timeout: 15_000 },
			);
			proof["outcome"] = "passed";
		} finally {
			rmSync(hold, { force: true });
			proof["after"] = snapshot(fixture, sessionId, prompt);
		}
	}, 90_000);

	it("fails an uncorrelated legacy send without selecting an unrelated newer turn", async () => {
		const { fixture, browser, sessionId, userId, created, directory, prompt } =
			await startOpenCodeTurn(true);
		const finished = openCodeHistory(sessionId, userId, created, true);
		await fixture.emitOpenCodeEvent({
			directory,
			payload: {
				id: randomUUID(),
				type: "message.updated",
				properties: { info: finished[1]?.info },
			},
		});
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
					"completed",
				),
			{ timeout: 15_000 },
		);
		const orphanPrompt = "legacy send with no durable native identity";
		const previousTurn = snapshot(fixture, sessionId, prompt).turns[0];
		expect(previousTurn?.state).toBe("completed");
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: orphanPrompt,
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, sessionId, orphanPrompt).providerPromptCount,
				).toBe(1),
			{ timeout: 15_000 },
		);
		const before = snapshot(fixture, sessionId, orphanPrompt);
		await fixture.kill();
		// A legacy provider history has no input ID and no reserved native ID.
		// A newer finished reply is not proof that this command produced it.
		const unrelatedId = `msg_unrelated_${randomUUID()}`;
		writeFileSync(
			join(fixture.configDir, "fake-opencode-history.json"),
			JSON.stringify({
				[sessionId]: [
					...finished,
					...openCodeHistory(sessionId, unrelatedId, Date.now(), true),
				],
			}),
		);
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		const proof: Record<string, unknown> = {
			case: "uncorrelated legacy send",
			sessionId,
			before,
		};
		proofs.push(proof);
		await fixture.restart({ skipBrowserProbe: true });
		try {
			await vi.waitFor(
				() => {
					const state = snapshot(fixture, sessionId, orphanPrompt);
					expect(state.outbox.map(({ status }) => status)).toEqual([
						"completed",
						"failed",
					]);
					expect(state.turns.find(({ id }) => id === userId)).toEqual(
						previousTurn,
					);
					const read = new Database(fixture.daemonStorePath(), {
						readonly: true,
					});
					try {
						expect(
							read
								.prepare("SELECT assistant_message_id FROM turns WHERE id = ?")
								.get(userId),
						).toEqual({ assistant_message_id: finished[1]?.info.id });
					} finally {
						read.close();
					}
					expect(
						state.turns.find(({ id }) => id === unrelatedId)?.state,
					).not.toBe("error");
					expect(state.inbox).toEqual({ busy: false, in_flight: false });
					expect(state.providerPromptCount).toBe(1);
				},
				{ timeout: 15_000 },
			);
			const after = await fixture.connect(sessionId);
			expect(
				(await after.history(sessionId)).some((message) =>
					message.parts?.some((part) => part.type === "error"),
				),
			).toBe(true);
			await fixture.kill();
			await fixture.restart({ skipBrowserProbe: true });
			expect(
				snapshot(fixture, sessionId, orphanPrompt).outbox.map(
					({ status }) => status,
				),
			).toEqual(["completed", "failed"]);
			expect(
				snapshot(fixture, sessionId, orphanPrompt).providerPromptCount,
			).toBe(1);
		} finally {
			proof["after"] = snapshot(fixture, sessionId, orphanPrompt);
		}
	}, 60_000);

	it("does not assign a delayed reserved echo to a newer input", async () => {
		const {
			fixture,
			browser,
			sessionId,
			inputId,
			userId,
			created,
			directory,
			prompt,
		} = await startOpenCodeTurn(false);
		// Idle cannot complete an input which upstream has not acknowledged.
		// A confirmed process stop settles that exact reservation; its delayed
		// echo must still keep its owner after the next input has been sent.
		const idleCount = () => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return (
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'session.status' AND json_extract(data, '$.status') = 'idle'",
						)
						.get(sessionId) as { count: number }
				).count;
			} finally {
				db.close();
			}
		};
		const beforeIdle = idleCount();
		await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
		await vi.waitFor(() => expect(idleCount()).toBeGreaterThan(beforeIdle));
		expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
			"running",
		);
		expect(snapshot(fixture, sessionId, prompt).inbox.busy).toBe(true);
		await browser.stopInstance(MANAGED_OPENCODE_ACCOUNT_ID);
		await vi.waitFor(
			() =>
				expect(snapshot(fixture, sessionId, prompt).outbox[0]?.status).toBe(
					"failed",
				),
			{ timeout: 15_000 },
		);
		// The reservation ended before native placement. Its delayed echo below
		// must inherit that end; stopping must not manufacture acceptance.
		expect(snapshot(fixture, sessionId, prompt).turns).toEqual([]);
		await browser.startInstance(MANAGED_OPENCODE_ACCOUNT_ID);
		const nextInputId = randomUUID();
		const nextPrompt = "send after delayed echo";
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: nextInputId,
				delivery: "queue",
				text: nextPrompt,
			}),
		);
		await vi.waitFor(
			() =>
				expect(
					snapshot(fixture, sessionId, nextPrompt).providerPromptCount,
				).toBe(1),
			{ timeout: 15_000 },
		);
		const request = JSON.parse(
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => path === `/session/${sessionId}/prompt_async`)
				.at(-1)?.body ?? "{}",
		) as { messageID?: string };
		if (!request.messageID) throw new Error("Missing reserved native user ID");
		const nextUserId = request.messageID;
		const proof: Record<string, unknown> = {
			case: "delayed reserved echo",
			sessionId,
			before: snapshot(fixture, sessionId, nextPrompt),
		};
		proofs.push(proof);
		try {
			for (const nativeId of [userId, nextUserId])
				await fixture.emitOpenCodeEvent({
					directory,
					payload: {
						id: randomUUID(),
						type: "message.updated",
						properties: {
							info: {
								id: nativeId,
								sessionID: sessionId,
								role: "user",
								time: { created },
								agent: "build",
								model: { providerID: "fake", modelID: "fake-model" },
							},
						},
					},
				});
			await vi.waitFor(
				() => {
					const db = new Database(fixture.daemonStorePath(), {
						readonly: true,
					});
					try {
						expect(
							db
								.prepare("SELECT input_id FROM messages WHERE id = ?")
								.get(nextUserId),
						).toEqual({ input_id: nextInputId });
						expect(
							db
								.prepare("SELECT id FROM messages WHERE input_id = ?")
								.all(nextInputId),
						).toEqual([{ id: nextUserId }]);
						const reserved = db
							.prepare(
								"SELECT command_id, run_id FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
							)
							.all(sessionId) as Array<{ command_id: string; run_id: string }>;
						expect(reserved.map(({ command_id }) => command_id)).toEqual([
							inputId,
							nextInputId,
						]);
						expect(
							db
								.prepare(
									"SELECT turns.run_id, turns.state, provider_runs.status AS run_status, turns.completed_at = provider_runs.completed_at AS inherited_terminal FROM turns JOIN provider_runs ON provider_runs.id = turns.run_id WHERE turns.id = ?",
								)
								.get(userId),
						).toEqual({
							run_id: reserved[0]?.run_id,
							state: "interrupted",
							run_status: "interrupted",
							inherited_terminal: 1,
						});
						expect(
							db
								.prepare("SELECT run_id, state FROM turns WHERE id = ?")
								.get(nextUserId),
						).toEqual({ run_id: reserved[1]?.run_id, state: "running" });
					} finally {
						db.close();
					}
				},
				{ timeout: 15_000 },
			);
			const reply = openCodeHistory(sessionId, nextUserId, Date.now(), true)[1];
			await fixture.emitOpenCodeEvent({
				directory,
				payload: {
					id: randomUUID(),
					type: "message.updated",
					properties: { info: reply?.info },
				},
			});
			await fixture.setOpenCodeStatus(directory, sessionId, { type: "idle" });
			await vi.waitFor(() => {
				const state = snapshot(fixture, sessionId, nextPrompt);
				expect(state.outbox.map(({ status }) => status)).toEqual([
					"failed",
					"completed",
				]);
				expect(state.inbox.busy).toBe(false);
				expect(state.providerPromptCount).toBe(1);
				expect(state.turns).toHaveLength(2);
			});
		} finally {
			proof["after"] = snapshot(fixture, sessionId, nextPrompt);
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				proof["echoMapping"] = db
					.prepare(
						"SELECT id, input_id FROM messages WHERE id IN (?, ?) ORDER BY created_at, rowid",
					)
					.all(userId, nextUserId);
			} finally {
				db.close();
			}
		}
	}, 60_000);
});
