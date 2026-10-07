import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClaudeRunnerHello,
	type ClaudeRunnerMessage,
	ClaudeRunnerSocket,
} from "../../../src/lib/provider/claude/claude-runner-protocol.js";
import type { ClaudeSessionTurn } from "../../../src/lib/provider/claude/claude-session-runner.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), {
		readonly: true,
	});
	try {
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			turns: db
				.prepare(
					"SELECT state, user_message_id, assistant_message_id FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId) as Array<{
				state: string;
				user_message_id: string;
				assistant_message_id: string | null;
			}>,
			approvals: db
				.prepare(
					"SELECT id, status FROM pending_approvals WHERE session_id = ?",
				)
				.all(sessionId) as Array<{ id: string; status: string }>,
			messages: db
				.prepare(
					"SELECT id, is_streaming FROM messages WHERE session_id = ? ORDER BY created_at, id",
				)
				.all(sessionId) as Array<{ id: string; is_streaming: number }>,
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as Array<{ type: string; data: string }>,
			commands: db
				.prepare(
					"SELECT o.command_id, o.status, r.status AS receipt_status FROM provider_command_outbox o LEFT JOIN command_receipts r ON r.command_id = o.command_id WHERE o.session_id = ? AND o.effect_type = 'send_turn' ORDER BY o.request_sequence",
				)
				.all(sessionId) as Array<{
				command_id: string;
				status: string;
				receipt_status: string;
			}>,
		};
	} finally {
		db.close();
	}
}

function comparable(
	events: Array<{ type: string; data: string }>,
	root: string,
) {
	const ids = new Map<string, string>();
	return JSON.parse(
		JSON.stringify(
			events.map(({ type, data }) => ({
				type,
				data: JSON.parse(data) as unknown,
			})),
			(key, value: unknown) => {
				if (
					/^(createdAt|startedAt|completedAt|timestamp|durationMs)$/.test(key)
				)
					return "<clock>";
				if (typeof value !== "string") return value;
				return value
					.replaceAll(root, "<root>")
					.replace(
						/ses_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
						(id) => {
							if (!ids.has(id)) ids.set(id, `id-${ids.size}`);
							return ids.get(id) ?? id;
						},
					);
			},
		),
	) as unknown;
}

function sdkProof(harness: ProcessHarness): Array<Record<string, unknown>> {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settled(harness: ProcessHarness, sessionId: string) {
	await vi.waitFor(
		() => {
			const { events, commands } = persisted(harness, sessionId);
			expect(commands.map(({ status }) => status)).toEqual(["completed"]);
			expect(events.at(-1)).toMatchObject({ type: "session.status" });
			expect(JSON.parse(events.at(-1)?.data ?? "{}")).toMatchObject({
				status: "idle",
			});
		},
		{ timeout: 10_000 },
	);
}

describe("Claude runners survive server replacement through built dist", () => {
	const harnesses: ProcessHarness[] = [];
	const cleanupProofs: unknown[] = [];
	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.dispose();
			expect(harness.remainingRunnerPids()).toEqual([]);
			cleanupProofs.push({
				root: harness.root,
				runnerPids: harness.runnerPids(),
				remainingPids: harness.remainingRunnerPids(),
			});
		}
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-9-cleanup.json",
			JSON.stringify({ proofs: cleanupProofs }, null, 2),
		);
		harnesses.length = 0;
	});

	it("idle-exits an adopted runner and transparently respawns on the following send", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
			runnerLifecycle: { nonDefaultConfigDir: true, idleDayMs: 250 },
		});
		harnesses.push(harness);
		let browser = await harness.connect();
		const sessionId = await browser.createSession("Adopted idle runner");
		await browser.setAutoSettle(null);
		await browser.send(sessionId, "before-adopted-idle");
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing original runner proof");
		expect(
			runner.socketPath.startsWith(
				`${join(harness.root, "active-config", "r")}/`,
			),
		).toBe(true);
		await harness.kill();
		expect(() => process.kill(runner.pid, 0)).not.toThrow();
		await harness.restart();
		browser = await harness.connect(sessionId);
		const adopted = harness.marks
			.filter((mark) => mark.kind === "runner-started")
			.at(-1);
		expect(adopted).toMatchObject({
			pid: runner.pid,
			socketPath: runner.socketPath,
		});
		await browser.preWarmSession(sessionId);
		expect(
			sdkProof(harness).filter((mark) => mark["kind"] === "query"),
		).toHaveLength(1);
		await browser.setAutoSettle(1);
		await vi.waitFor(
			() => {
				expect(
					harness.marks.some(
						(mark) =>
							mark.kind === "runner-idle-exit-started" &&
							mark.pid === runner.pid,
					),
				).toBe(true);
				expect(() => process.kill(runner.pid, 0)).toThrow();
				expect(existsSync(runner.socketPath)).toBe(false);
			},
			{ timeout: 5000 },
		);
		const reply = await browser.send(sessionId, "after-adopted-idle");
		expect(reply.chunks.join("")).toBe(
			responseChunks("after-adopted-idle").join(""),
		);
		expect(reply.done["status"]).toBe("idle");
		const replacement = harness.marks
			.filter((mark) => mark.kind === "runner-started")
			.at(-1);
		if (replacement?.kind !== "runner-started")
			throw new Error("Missing replacement runner proof");
		expect(replacement.pid).not.toBe(runner.pid);
		await vi.waitFor(() => {
			const { events, commands } = persisted(harness, sessionId);
			expect(commands.map(({ status }) => status)).toEqual([
				"completed",
				"completed",
			]);
			expect(events.some((event) => event.type === "turn.error")).toBe(false);
		});
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-9-adopted-idle.json",
			JSON.stringify(
				{
					originalPid: runner.pid,
					adopted,
					replacementPid: replacement.pid,
					sdk: sdkProof(harness),
					persisted: persisted(harness, sessionId),
				},
				null,
				2,
			),
		);
	}, 30_000);

	it("replays a full turn exactly once after SIGKILL, including a committed output whose ack was lost", async () => {
		const sequences: unknown[] = [];
		const proofs: unknown[] = [];
		for (const restart of [false, true]) {
			const harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
				holdRunnerAck: restart,
			});
			harnesses.push(harness);
			let browser = await harness.connect();
			const sessionId = await browser.createSession("Restart proof");
			const pending = browser
				.send(sessionId, "restart-stream")
				.catch(() => undefined);
			await browser.waitFor(
				(message) =>
					message["type"] === "transcript_message" &&
					message["role"] === "assistant" &&
					(message["parts"] as HistoryMessage["parts"])?.some(
						(part) => part.type === "text" && Boolean(part.text),
					) === true,
			);
			const runner = harness.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			if (runner?.kind !== "runner-started")
				throw new Error("Missing verified runner");
			let spooledBytes = 0;
			if (restart) {
				await harness.kill();
				expect(() => process.kill(runner.pid, 0)).not.toThrow();
				await vi.waitFor(() =>
					expect(statSync(`${runner.socketPath}.spool`).size).toBeGreaterThan(
						0,
					),
				);
				await vi.waitFor(() =>
					expect(
						sdkProof(harness).filter((mark) => mark["kind"] === "emit"),
					).toHaveLength(3),
				);
				spooledBytes = statSync(`${runner.socketPath}.spool`).size;
				await harness.restart();
				browser = await harness.connect(sessionId);
			} else await pending;
			await settled(harness, sessionId);
			await browser.view(sessionId);
			const history = await browser.history(sessionId);
			expect(JSON.stringify(history)).toContain(
				responseChunks("restart-stream").join(""),
			);
			await vi.waitFor(() =>
				expect(statSync(`${runner.socketPath}.spool`).size).toBe(0),
			);
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark["kind"] === "enqueue" && mark["prompt"] === "restart-stream",
				),
			).toHaveLength(1);
			const stored = persisted(harness, sessionId);
			expect(
				stored.events.filter(
					({ type, data }) =>
						type === "text.delta" &&
						responseChunks("restart-stream").includes(
							String((JSON.parse(data) as { text?: string }).text),
						),
				),
			).toHaveLength(3);
			sequences.push(comparable(stored.events, harness.root));
			proofs.push({
				restart,
				runner,
				spooledBytes,
				spoolAfterAck: statSync(`${runner.socketPath}.spool`).size,
				sdk: sdkProof(harness),
				history,
				...stored,
				process: harness.proof(),
			});
		}
		expect(sequences[1]).toEqual(sequences[0]);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-9-restart.json",
			JSON.stringify({ sequences, proofs }, null, 2),
		);
	}, 60_000);

	it.each([
		"crash",
		"graceful",
		"uncommitted-ask",
		"committed-answer",
	] as const)("restores a Session Approval across %s restart", async (scenario) => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
			...(scenario === "uncommitted-ask"
				? { holdRunnerOutput: "permission-request" as const }
				: scenario === "committed-answer"
					? { holdRunnerOutput: "answer-permission" as const }
					: {}),
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Approval restart proof");
		const pending = before
			.send(sessionId, "approval-restart")
			.catch(() => undefined);
		const request =
			scenario === "uncommitted-ask"
				? undefined
				: await before.waitFor(
						(message) => message["type"] === "permission_pending",
					);
		if (scenario === "committed-answer" && request)
			await before.answerApproval(request, "allow_always");
		if (scenario === "uncommitted-ask" || scenario === "committed-answer")
			await vi.waitFor(
				() =>
					expect(
						sdkProof(harness).some((mark) => mark["kind"] === "held-output"),
					).toBe(true),
				{ timeout: 15_000 },
			);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		if (scenario === "graceful") {
			await before.restartServer();
			await harness.waitForExit();
		} else await harness.kill();
		await pending;
		expect(existsSync(runner.socketPath)).toBe(true);
		await harness.restart();
		const after = await harness.connect(sessionId);
		await after.view(sessionId);
		if (scenario !== "committed-answer") {
			const recovered =
				request ??
				(await after.waitFor(
					(message) => message["type"] === "permission_pending",
				));
			await after.answerApproval(recovered, "allow");
		}
		if (scenario !== "committed-answer") await after.waitForTurnEnd(sessionId);
		await settled(harness, sessionId);
		expect(JSON.stringify(await after.history(sessionId))).toContain(
			responseChunks("approval-restart").join(""),
		);
		expect(
			sdkProof(harness).filter((mark) => mark["kind"] === "enqueue"),
		).toHaveLength(1);
		const approvals = sdkProof(harness).filter(
			(mark) => mark["kind"] === "approval",
		);
		expect(approvals).toHaveLength(1);
		expect(approvals[0]).toMatchObject({
			kind: "approval",
			prompt: "approval-restart",
			behavior: "allow",
		});
		if (scenario === "committed-answer")
			expect(approvals[0]?.["updatedPermissions"]).toEqual([
				{
					type: "addRules",
					rules: [{ toolName: "Bash", ruleContent: "printf harness-approved" }],
					behavior: "allow",
					destination: "session",
				},
			]);
		const stored = persisted(harness, sessionId);
		expect(
			stored.events.filter(({ type }) => type === "permission.asked"),
		).toHaveLength(1);
		expect(
			stored.events.filter(({ type }) => type === "permission.resolved"),
		).toHaveLength(1);
		await vi.waitFor(() =>
			expect(statSync(`${runner.socketPath}.spool`).size).toBe(0),
		);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			`test-results/85kb-9-approval-${scenario}.json`,
			JSON.stringify(
				{
					scenario,
					runner,
					...stored,
					sdk: sdkProof(harness),
					process: harness.proof(),
				},
				null,
				2,
			),
		);
	}, 60_000);

	it("drains an interrupted terminal replay before acting on a cached failed send receipt", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Terminal replay ordering");
		const prompt = "terminal-replay-interrupt";
		const pending = before.send(sessionId, prompt).catch(() => undefined);
		await vi.waitFor(
			() => {
				expect(existsSync(join(harness.root, "sdk-proof.ndjson"))).toBe(true);
				expect(
					sdkProof(harness).some((mark) => mark["kind"] === "assistant-held"),
				).toBe(true);
			},
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		const db = new Database(harness.projectStorePath());
		const command = db
			.prepare(
				"SELECT command_id, payload_json, attempt_count FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
			)
			.get(sessionId) as {
			command_id: string;
			payload_json: string;
			attempt_count: number;
		};
		const upstreamPath = `${runner.socketPath}.upstream`;
		const sockets = new Set<Socket>();
		const held: string[] = [];
		const wire: Array<{ direction: string; message: ClaudeRunnerMessage }> = [];
		let cachedReceived: (socket: Socket) => void = () => {};
		const cachedReady = new Promise<Socket>((resolve) => {
			cachedReceived = resolve;
		});
		let retriesReceived = () => {};
		const retryBarrier = new Promise<void>((resolve) => {
			retriesReceived = resolve;
		});
		let retries = 0;
		let released = false;
		const proxy = createServer((client) => {
			const upstream = createConnection(upstreamPath);
			for (const socket of [client, upstream]) {
				sockets.add(socket);
				socket.once("close", () => sockets.delete(socket));
				socket.on("error", () => {
					client.destroy();
					upstream.destroy();
				});
			}
			client.once("close", () => upstream.destroy());
			upstream.once("close", () => client.destroy());
			let incoming = "";
			client.on("data", (chunk: Buffer) => {
				incoming += chunk.toString();
				while (incoming.includes("\n")) {
					const boundary = incoming.indexOf("\n");
					const line = incoming.slice(0, boundary);
					incoming = incoming.slice(boundary + 1);
					const message = JSON.parse(line) as ClaudeRunnerMessage;
					wire.push({ direction: "server-to-runner", message });
					if (released && message.type === "replay" && ++retries >= 2)
						retriesReceived();
					upstream.write(`${line}\n`);
				}
			});
			let outgoing = "";
			upstream.on("data", (chunk: Buffer) => {
				outgoing += chunk.toString();
				while (outgoing.includes("\n")) {
					const boundary = outgoing.indexOf("\n");
					const line = outgoing.slice(0, boundary);
					outgoing = outgoing.slice(boundary + 1);
					const message = JSON.parse(line) as ClaudeRunnerMessage;
					wire.push({ direction: "runner-to-server", message });
					if (message.type === "hello" || released) client.write(`${line}\n`);
					else held.push(`${line}\n`);
					if (
						message.type === "command-reply" &&
						message.commandId === command.command_id &&
						message.failure
					)
						cachedReceived(client);
				}
			});
		});
		let direct: ClaudeRunnerSocket | undefined;
		let directHello: ClaudeRunnerHello | undefined;
		let cachedFailure: unknown;
		let blockedState: ReturnType<typeof persisted> | undefined;
		let burst: ClaudeRunnerMessage[] = [];
		try {
			await harness.kill();
			await pending;
			const socket = createConnection(runner.socketPath);
			const greeted = new Promise<{
				hello: ClaudeRunnerHello;
				peer: ClaudeRunnerSocket;
			}>((resolve, reject) => {
				const peer = new ClaudeRunnerSocket(
					socket,
					(message) => {
						if (message.type === "hello") resolve({ hello: message, peer });
					},
					(failure) => reject(new Error(failure.message)),
				);
				direct = peer;
				socket.once("connect", () =>
					peer.write({
						type: "hello",
						protocolVersion: runner.protocolVersion,
						buildId: runner.buildId,
						config: {
							workspaceRoot: harness.projectDir,
							daemonConfigDir: harness.configDir,
							materializeSubagents: false,
						},
					}),
				);
			});
			const greeting = await Effect.runPromise(
				Effect.tryPromise(() => greeted).pipe(Effect.timeout("15 seconds")),
			);
			directHello = greeting.hello;
			direct = greeting.peer;
			expect(directHello).toMatchObject({
				pid: runner.pid,
				runnerId: basename(runner.socketPath),
				sessionId,
			});
			const binding = directHello.bindings?.find(
				(candidate) => candidate.commandId === command.command_id,
			);
			if (!binding) throw new Error("Missing original runner binding");
			// No replay attachment: terminal output stays spooled while the send
			// settles, reproducing a server that missed the runner's final reply.
			await Effect.runPromise(
				direct
					.commandEffect(randomUUID(), { type: "end-session", sessionId })
					.pipe(Effect.timeout("15 seconds")),
			);
			cachedFailure = await Effect.runPromise(
				Effect.either(
					direct.commandEffect(
						command.command_id,
						{
							type: "send-turn",
							sinkId: binding.sinkId,
							aborted: false,
							input: {
								...(JSON.parse(command.payload_json) as ClaudeSessionTurn),
								commandId: command.command_id,
								commandAttempt: command.attempt_count,
							},
						},
						command.attempt_count,
					),
				).pipe(Effect.timeout("15 seconds")),
			);
			expect(cachedFailure).toMatchObject({ _tag: "Left" });
			await new Promise<void>((resolve) => {
				socket.once("close", resolve);
				direct?.destroy();
			});
			renameSync(runner.socketPath, upstreamPath);
			await new Promise<void>((resolve, reject) => {
				proxy.once("error", reject);
				proxy.listen(runner.socketPath, resolve);
			});
			db.exec(`CREATE TRIGGER hold_terminal_replay BEFORE INSERT ON events
				WHEN NEW.type = 'turn.interrupted'
				BEGIN SELECT RAISE(FAIL, 'Held terminal replay'); END`);
			await harness.restart();
			const after = await harness.connect(sessionId);
			await after.view(sessionId);
			const downstream = await Effect.runPromise(
				Effect.promise(() => cachedReady).pipe(Effect.timeout("15 seconds")),
			);
			burst = held.map((line) => JSON.parse(line) as ClaudeRunnerMessage);
			const terminalIndex = burst.findIndex(
				(message) =>
					message.type === "output" &&
					message.output.type === "event" &&
					message.output.event.type === "turn.interrupted",
			);
			const failedReplyIndex = burst.findIndex(
				(message) =>
					message.type === "command-reply" &&
					message.commandId === command.command_id &&
					message.failure !== undefined,
			);
			expect(terminalIndex).toBeGreaterThanOrEqual(0);
			expect(failedReplyIndex).toBeGreaterThan(terminalIndex);
			expect(
				harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
			).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
			released = true;
			downstream.write(held.join(""));
			held.length = 0;
			await Effect.runPromise(
				Effect.promise(() => retryBarrier).pipe(Effect.timeout("15 seconds")),
			);
			blockedState = persisted(harness, sessionId);
			expect(
				blockedState.events.filter((event) =>
					["turn.completed", "turn.error", "turn.interrupted"].includes(
						event.type,
					),
				),
			).toEqual([]);
			expect(blockedState.turns).toMatchObject([{ state: "running" }]);
			expect(
				after.frames.filter(
					({ message }) =>
						message["type"] === "session_row" &&
						message["id"] === sessionId &&
						message["status"] === "idle",
				),
			).toEqual([]);
			const releaseCursor = after.frames.length;
			db.exec("DROP TRIGGER hold_terminal_replay");
			await vi.waitFor(
				() => {
					const state = persisted(harness, sessionId);
					expect(state).toMatchObject({
						session: { status: "idle" },
						turns: [{ state: "interrupted" }],
						commands: [
							{ status: "failed", receipt_status: "side_effect_failed" },
						],
					});
					expect(
						state.events.filter((event) =>
							["turn.completed", "turn.error", "turn.interrupted"].includes(
								event.type,
							),
						),
					).toEqual([expect.objectContaining({ type: "turn.interrupted" })]);
				},
				{ timeout: 15_000 },
			);
			await after.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === sessionId &&
					message["status"] === "idle",
				releaseCursor,
			);
			await vi.waitFor(() =>
				expect(statSync(`${runner.socketPath}.spool`).size).toBe(0),
			);
			expect(
				persisted(harness, sessionId).events.filter((event) =>
					["turn.completed", "turn.error", "turn.interrupted"].includes(
						event.type,
					),
				),
			).toEqual([expect.objectContaining({ type: "turn.interrupted" })]);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query"),
			).toHaveLength(1);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "enqueue"),
			).toHaveLength(1);
		} finally {
			const evidence = {
				runner,
				directHello,
				cachedFailure,
				burst,
				retries,
				blockedState,
				persisted: persisted(harness, sessionId),
				sdk: sdkProof(harness),
				wire,
				process: harness.proof(),
			};
			db.exec("DROP TRIGGER IF EXISTS hold_terminal_replay");
			db.close();
			direct?.destroy();
			await harness.kill();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
			if (existsSync(upstreamPath)) renameSync(upstreamPath, runner.socketPath);
			await harness.dispose();
			expect(harness.remainingRunnerPids()).toEqual([]);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-terminal-replay-interrupted.json",
				JSON.stringify({ ...evidence, cleanup: harness.proof() }, null, 2),
			);
		}
	}, 75_000);

	it("recovers an admitted command absent from runner hello with its launch environment and settings", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
			shellEnvProof: true,
			holdRunnerOutput: "send-turn",
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Recovered unseen command");
		await Effect.runPromise(
			before.rpc.SetClaudeSettings({
				projectSlug: "process-test",
				overrides: { disableAllHooks: true },
				originId: before.originId,
			}),
		);
		const prompt = "approval-unseen-recovery";
		const pending = before.send(sessionId, prompt).catch(() => undefined);
		await vi.waitFor(
			() => {
				expect(existsSync(join(harness.root, "sdk-proof.ndjson"))).toBe(true);
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark["kind"] === "held-output" && mark["type"] === "send-turn",
					),
				).toBe(true);
			},
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		const admitted = persisted(harness, sessionId);
		expect(admitted).toMatchObject({
			turns: [{ state: "pending", assistant_message_id: null }],
			commands: [{ status: "running" }],
		});
		expect(
			sdkProof(harness).filter(
				(mark) => mark["kind"] === "query" || mark["kind"] === "enqueue",
			),
		).toEqual([]);
		await harness.kill();
		await pending;
		try {
			await harness.restart();
			const after = await harness.connect(sessionId);
			await after.view(sessionId);
			const approval = await after.waitFor(
				(message) => message["type"] === "permission_pending",
			);
			expect(
				harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
			).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
			const queries = sdkProof(harness).filter(
				(mark) => mark["kind"] === "query",
			);
			expect(queries).toHaveLength(1);
			expect(queries[0]).toMatchObject({
				pid: runner.pid,
				options: { settings: { disableAllHooks: true } },
				env: {
					CONDUIT_ENV_PROOF: "server-cache",
					PATH: expect.stringMatching(/^\/tmp\/conduit-cached-env-bin:/),
					CLAUDE_AGENT_SDK_CLIENT_APP: "conduit",
					ENABLE_CLAUDEAI_MCP_SERVERS: "false",
				},
			});
			const env = queries[0]?.["env"] as Record<string, unknown>;
			expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
			expect(env["ANTHROPIC_MODEL"]).toBeUndefined();
			await after.answerApproval(approval, "allow");
			expect(await after.waitForTurnEnd(sessionId)).toMatchObject({
				id: sessionId,
				status: "idle",
				lastTurnEndVersion: expect.any(Number),
			});
			await settled(harness, sessionId);
			expect(persisted(harness, sessionId)).toMatchObject({
				session: { status: "idle" },
				turns: [{ state: "completed" }],
				commands: [
					{ status: "completed", receipt_status: "side_effect_completed" },
				],
			});
			expect(
				persisted(harness, sessionId).events.some(
					(event) => event.type === "turn.error",
				),
			).toBe(false);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "enqueue"),
			).toHaveLength(1);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-w3fix-recovered-unseen-command.json",
				JSON.stringify(
					{
						runner,
						admitted,
						persisted: persisted(harness, sessionId),
						sdk: sdkProof(harness),
						process: harness.proof(),
					},
					null,
					2,
				),
			);
		}
	}, 45_000);

	it("preserves an adopted approval turn through another graceful server restart", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Repeated graceful restart");
		const pending = before
			.send(sessionId, "approval-repeated-restart")
			.catch(() => undefined);
		const approval = await before.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		await harness.kill();
		await pending;
		await harness.restart();
		const adopted = await harness.connect(sessionId);
		await adopted.view(sessionId);
		await adopted.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === approval["requestId"],
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
		).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
		try {
			await adopted.restartServer();
			await harness.waitForExit();
			expect(() => process.kill(runner.pid, 0)).not.toThrow();
			expect(existsSync(runner.socketPath)).toBe(true);
			await harness.restart();
			const after = await harness.connect(sessionId);
			await after.view(sessionId);
			const recovered = await after.waitFor(
				(message) =>
					message["type"] === "permission_pending" &&
					message["requestId"] === approval["requestId"],
			);
			const attachments = harness.marks.filter(
				(mark) => mark.kind === "runner-started",
			);
			expect(attachments).toHaveLength(3);
			for (const attachment of attachments)
				expect(attachment).toMatchObject({
					pid: runner.pid,
					socketPath: runner.socketPath,
				});
			expect(persisted(harness, sessionId)).toMatchObject({
				session: { status: "busy" },
				turns: [{ state: "running" }],
				commands: [{ status: "running" }],
				approvals: [{ status: "pending" }],
			});
			await after.answerApproval(recovered, "allow");
			expect(await after.waitForTurnEnd(sessionId)).toMatchObject({
				id: sessionId,
				status: "idle",
				lastTurnEndVersion: expect.any(Number),
			});
			await settled(harness, sessionId);
			const state = persisted(harness, sessionId);
			expect(state).toMatchObject({
				session: { status: "idle" },
				turns: [{ state: "completed" }],
				commands: [
					{ status: "completed", receipt_status: "side_effect_completed" },
				],
			});
			expect(state.events.some((event) => event.type === "turn.error")).toBe(
				false,
			);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "enqueue"),
			).toHaveLength(1);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-w3fix-repeated-graceful-restart.json",
				JSON.stringify(
					{
						runner,
						persisted: persisted(harness, sessionId),
						sdk: sdkProof(harness),
						process: harness.proof(),
					},
					null,
					2,
				),
			);
		}
	}, 75_000);

	it("terminalizes an adopted runner crash during approval and restores terminal state on reconnect", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Adopted approval crash");
		const pending = before
			.send(sessionId, "approval-adopted-crash")
			.catch(() => undefined);
		const approval = await before.waitFor(
			(message) => message["type"] === "permission_pending",
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		const active = persisted(harness, sessionId);
		expect(active).toMatchObject({
			session: { status: "busy" },
			turns: [{ state: "running" }],
			commands: [{ status: "running" }],
			approvals: [{ status: "pending" }],
		});
		expect(active.turns[0]?.assistant_message_id).toEqual(expect.any(String));
		await harness.kill();
		await pending;
		await harness.restart();
		const after = await harness.connect(sessionId);
		await after.view(sessionId);
		await after.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === approval["requestId"],
		);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
		).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
		let reconnectProof: unknown;
		try {
			process.kill(runner.pid, "SIGKILL");
			await vi.waitFor(
				() => {
					const state = persisted(harness, sessionId);
					expect(state).toMatchObject({
						session: { status: "idle" },
						turns: [{ state: "error" }],
						commands: [
							{ status: "failed", receipt_status: "side_effect_failed" },
						],
						approvals: [{ status: "resolved" }],
					});
					const errors = state.events.filter(
						(event) => event.type === "turn.error",
					);
					expect(errors).toHaveLength(1);
					expect(JSON.parse(errors[0]?.data ?? "{}")).toMatchObject({
						messageId: active.turns[0]?.assistant_message_id,
						error: expect.any(String),
					});
					expect(
						state.messages.find(
							(message) => message.id === active.turns[0]?.assistant_message_id,
						),
					).toMatchObject({ is_streaming: 0 });
				},
				{ timeout: 5000 },
			);
			expect(await after.waitForTurnEnd(sessionId)).toMatchObject({
				id: sessionId,
				status: "idle",
				lastTurnEndVersion: expect.any(Number),
			});
			await after.close();
			const reconnect = await harness.connect(sessionId);
			await reconnect.view(sessionId);
			const sessions = await Effect.runPromise(
				reconnect.rpc.ListDaemonSessions({ projectSlug: "process-test" }),
			);
			expect(
				sessions.sessions.find((session) => session.id === sessionId),
			).toMatchObject({ status: "idle" });
			expect(
				reconnect.frames.some(
					({ message }) => message["type"] === "permission_pending",
				),
			).toBe(false);
			reconnectProof = {
				sessions,
				history: await reconnect.history(sessionId),
			};
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "enqueue"),
			).toHaveLength(1);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-w3fix-adopted-approval-crash.json",
				JSON.stringify(
					{
						runner,
						active,
						persisted: persisted(harness, sessionId),
						reconnect: reconnectProof,
						sdk: sdkProof(harness),
						process: harness.proof(),
					},
					null,
					2,
				),
			);
		}
	}, 45_000);

	it("terminalizes the owning pending turn when the adopted SDK fails before an assistant message", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const before = await harness.connect();
		const sessionId = await before.createSession("Adopted early SDK failure");
		const prompt = "fail-before-assistant-restart";
		const pending = before.send(sessionId, prompt).catch(() => undefined);
		await vi.waitFor(
			() => {
				expect(existsSync(join(harness.root, "sdk-proof.ndjson"))).toBe(true);
				expect(
					sdkProof(harness).some(
						(mark) => mark["kind"] === "pre-assistant-held",
					),
				).toBe(true);
			},
			{ timeout: 15_000 },
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		const active = persisted(harness, sessionId);
		expect(active.turns).toEqual([
			{
				state: "pending",
				user_message_id: expect.any(String),
				assistant_message_id: null,
			},
		]);
		expect(active.commands).toMatchObject([{ status: "running" }]);
		await harness.kill();
		await pending;
		await harness.restart();
		const after = await harness.connect(sessionId);
		await after.view(sessionId);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
		).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
		expect(persisted(harness, sessionId).turns).toEqual(active.turns);
		try {
			writeFileSync(join(harness.root, "release-before-assistant"), "release");
			await vi.waitFor(
				() => {
					const state = persisted(harness, sessionId);
					expect(state).toMatchObject({
						session: { status: "idle" },
						turns: [{ state: "error", assistant_message_id: null }],
						commands: [
							{ status: "failed", receipt_status: "side_effect_failed" },
						],
					});
					const errors = state.events.filter(
						(event) => event.type === "turn.error",
					);
					expect(errors).toHaveLength(1);
					expect(JSON.parse(errors[0]?.data ?? "{}")).toMatchObject({
						userMessageId: active.turns[0]?.user_message_id,
					});
					expect(
						state.events.some(
							(event) =>
								event.type === "message.created" &&
								(JSON.parse(event.data) as { role?: string }).role ===
									"assistant",
						),
					).toBe(false);
				},
				{ timeout: 5000 },
			);
			expect(await after.waitForTurnEnd(sessionId)).toMatchObject({
				id: sessionId,
				status: "idle",
				lastTurnEndVersion: expect.any(Number),
			});
			expect(
				sdkProof(harness).filter(
					(mark) => mark["kind"] === "enqueue" && mark["prompt"] === prompt,
				),
			).toHaveLength(1);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-w3fix-adopted-early-sdk-failure.json",
				JSON.stringify(
					{
						runner,
						active,
						persisted: persisted(harness, sessionId),
						sdk: sdkProof(harness),
						process: harness.proof(),
					},
					null,
					2,
				),
			);
		}
	}, 45_000);

	it("adopts a runner after SIGKILL and more than 60 seconds detached without losing its turn", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Long detached turn");
		const prompt = "upgrade-long-turn";
		const pending = browser.send(sessionId, prompt).catch(() => undefined);
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				(message["parts"] as HistoryMessage["parts"])?.some(
					(part) =>
						part.type === "text" &&
						part.text?.includes(responseChunks(prompt)[0] ?? ""),
				) === true,
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		const registration = JSON.parse(
			readFileSync(`${runner.socketPath}.json`, "utf8"),
		) as { runnerId: string; pid: number };
		const samples: Array<{ elapsedMs: number; alive: boolean }> = [];
		const evidence: Record<string, unknown> = {
			runner,
			registration,
			minimumDetachedMs: 61_000,
			samples,
		};
		try {
			expect(persisted(harness, sessionId).turns).toMatchObject([
				{ state: "running" },
			]);
			await harness.kill();
			await pending;
			expect(harness.generations.at(-1)?.signal).toBe("SIGKILL");
			const detachedAt = Date.now();
			writeFileSync(
				join(harness.root, "release-upgrade-turn"),
				"finish detached",
			);
			await vi.waitFor(
				() => {
					const spool = readFileSync(`${runner.socketPath}.spool`, "utf8");
					expect(spool).toContain('"type":"turn.completed"');
				},
				{ timeout: 5000 },
			);
			evidence["completedWhileDetached"] = true;
			// This is the only acceptance case with a gap exceeding the former 60s
			// grace. Sample liveness throughout, so a replacement PID cannot pass.
			do {
				const alive = harness.remainingRunnerPids().includes(runner.pid);
				samples.push({ elapsedMs: Date.now() - detachedAt, alive });
				expect(alive).toBe(true);
				expect(existsSync(`${runner.socketPath}.json`)).toBe(true);
				if (Date.now() - detachedAt >= 61_000) break;
				await new Promise<void>((done) => setTimeout(done, 250));
			} while ((samples.at(-1)?.elapsedMs ?? 0) < 61_000);
			evidence["detachedMs"] = Date.now() - detachedAt;
			expect(evidence["detachedMs"]).toBeGreaterThan(60_000);
			await harness.restart();
			const adopted = await harness.connect(sessionId);
			await settled(harness, sessionId);
			const restored = JSON.parse(
				readFileSync(`${runner.socketPath}.json`, "utf8"),
			) as { runnerId: string; pid: number };
			expect(restored).toMatchObject(registration);
			expect(
				harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
			).toMatchObject({ pid: runner.pid, socketPath: runner.socketPath });
			const history = await adopted.history(sessionId);
			expect(history.map((message) => message.role)).toEqual([
				"user",
				"assistant",
			]);
			expect(history[1]?.parts?.map((part) => part.text ?? "").join("")).toBe(
				responseChunks(prompt).join(""),
			);
			const state = persisted(harness, sessionId);
			expect(state.turns).toMatchObject([{ state: "completed" }]);
			expect(
				state.events.filter((event) => event.type === "turn.completed"),
			).toHaveLength(1);
			expect(
				state.events.some(
					(event) =>
						event.type === "turn.interrupted" || event.type === "turn.error",
				),
			).toBe(false);
			expect(
				sdkProof(harness).filter((mark) => mark["kind"] === "query"),
			).toHaveLength(1);
			evidence["adoptedRegistration"] = restored;
			evidence["history"] = history;
			evidence["persisted"] = state;
		} finally {
			writeFileSync(join(harness.root, "release-upgrade-turn"), "cleanup");
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/v4e7-long-detached-turn.json",
				JSON.stringify({ ...evidence, process: harness.proof() }, null, 2),
			);
		}
	}, 100_000);

	it("terminates a suspended runner when its test parent disconnects", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Parent disconnect proof");
		await browser.send(sessionId, "parent-disconnect");
		await settled(harness, sessionId);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing verified runner");
		process.kill(runner.pid, "SIGSTOP");
		try {
			await harness.disconnectParent();
			expect(() => process.kill(runner.pid, 0)).toThrow();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-9-parent-disconnect.json",
				JSON.stringify(
					{ runner, runnerExited: true, process: harness.proof() },
					null,
					2,
				),
			);
		} finally {
			// This PID was verified before this test suspended its runner.
			try {
				process.kill(runner.pid, "SIGKILL");
			} catch {
				/* Already exited. */
			}
		}
	}, 30_000);
});
