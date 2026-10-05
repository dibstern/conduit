import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.projectStorePath(), {
		readonly: true,
	});
	try {
		const events = db
			.prepare(
				"SELECT stream_version, type, data, metadata, provider FROM events WHERE session_id = ? ORDER BY sequence",
			)
			.all(sessionId) as Array<{
			stream_version: number;
			type: string;
			data: string;
			metadata: string;
			provider: string;
		}>;
		const commands = db
			.prepare(
				"SELECT command_id, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
			)
			.all(sessionId) as Array<{ command_id: string; status: string }>;
		return {
			session: db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string },
			turns: db
				.prepare(
					"SELECT state, assistant_message_id FROM turns WHERE session_id = ?",
				)
				.all(sessionId) as Array<{
				state: string;
				assistant_message_id: string | null;
			}>,
			commands,
			events: events.map((event) => ({
				...event,
				data: JSON.parse(event.data) as unknown,
				metadata: JSON.parse(event.metadata) as unknown,
			})),
		};
	} finally {
		db.close();
	}
}

function sdkProof(harness: ProcessHarness): ProcessMark[] {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ProcessMark);
}

// Preserve payloads and ID relationships while removing opaque IDs, clocks,
// and the isolated fixture's paths from the repeatable event artifact.
function normalize(value: unknown, root: string): unknown {
	const ids = new Map<string, string>();
	return JSON.parse(
		JSON.stringify(value, (key, item: unknown) => {
			if (/^(createdAt|startedAt|completedAt|timestamp|durationMs)$/.test(key))
				return "<clock>";
			if (typeof item !== "string") return item;
			return item
				.replaceAll(root, "<root>")
				.replace(
					/ses_[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
					(id) => {
						if (!ids.has(id)) ids.set(id, `id-${ids.size}`);
						return ids.get(id) ?? id;
					},
				);
		}),
	) as unknown;
}

async function settled(
	harness: ProcessHarness,
	sessionId: string,
	turns: number,
) {
	await vi.waitFor(
		() => {
			const { commands, events } = persisted(harness, sessionId);
			expect(commands.map((command) => command.status)).toEqual(
				Array.from({ length: turns }, () => "completed"),
			);
			expect(events.at(-1)?.type).toBe("session.status");
			expect(events.at(-1)?.data).toMatchObject({ status: "idle" });
		},
		{ timeout: 5000 },
	);
}

describe("Claude session process runner", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async (context) => {
		for (const harness of harnesses) await harness.dispose();
		mkdirSync("test-results/process-harness", { recursive: true });
		writeFileSync(
			`test-results/process-harness/${context.task.name.replace(/\W+/g, "-")}.json`,
			JSON.stringify(
				harnesses.map((harness) => harness.proof()),
				null,
				2,
			),
		);
		harnesses.length = 0;
	});

	it.each([
		"allow",
		"deny",
	] as const)("persists send, stream and Session Approval through the default runner with decision %s", async (decision) => {
		const harness = await ProcessHarness.start({ shellEnvProof: true });
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Runner parity");
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(0);
		for (const prompt of ["stream-parity", "warm-parity"]) {
			const turn = await browser.send(sessionId, prompt);
			expect(turn.chunks).toEqual(responseChunks(prompt));
			expect(turn.done["code"]).toBe(0);
			await settled(harness, sessionId, prompt === "stream-parity" ? 1 : 2);
		}
		const cursor = browser.frames.length;
		const pending = browser.send(sessionId, "approval-parity");
		const request = await browser.waitFor(
			(message) => message["type"] === "permission_request",
			cursor,
		);
		expect(request["toolInput"]).toEqual({
			command: "printf harness-approved",
		});
		expect(
			browser.frames
				.slice(cursor)
				.some(({ message }) => message["type"] === "tool_result"),
		).toBe(false);
		await browser.answerApproval(request, decision);
		expect((await pending).chunks).toEqual(responseChunks("approval-parity"));
		const resolved = await browser.waitFor(
			(message) =>
				message["type"] === "permission_resolved" &&
				message["requestId"] === request["requestId"],
			cursor,
		);
		expect(resolved["decision"]).toBe(decision === "allow" ? "once" : "reject");
		const result = await browser.waitFor(
			(message) => message["type"] === "tool_result",
			cursor,
		);
		expect(result["content"]).toBe(
			decision === "allow" ? "harness-approved" : "harness-denied",
		);
		await vi.waitFor(() =>
			expect(
				harness.marks.filter((mark) => mark.kind === "query"),
			).toHaveLength(1),
		);
		const query = harness.marks.find((mark) => mark.kind === "query");
		if (query?.kind !== "query") throw new Error("Missing SDK query proof");
		expect(query.env["CONDUIT_ENV_PROOF"]).toBe("server-cache");
		expect(query.env["PATH"]).toMatch(/^\/tmp\/conduit-cached-env-bin:/);
		expect(query.env["ANTHROPIC_API_KEY"]).toBeUndefined();
		expect(query.env["ANTHROPIC_MODEL"]).toBeUndefined();
		expect(query.env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toBe("conduit");
		expect(query.env["ENABLE_CLAUDEAI_MCP_SERVERS"]).toBe("false");
		expect(query.pid).not.toBe(harness.generations[0]?.pid);
		expect(query.pid).not.toBe(process.pid);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing runner proof");
		expect(runner.pid).toBe(query.pid);
		expect(runner.sessionId).toBe(sessionId);
		expect(runner.socketPath.startsWith(join(harness.root, "config"))).toBe(
			true,
		);
		expect(Buffer.byteLength(runner.socketPath)).toBeLessThan(104);
		expect(existsSync(runner.socketPath)).toBe(true);
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(1);
		await settled(harness, sessionId, 3);
		const { events, commands } = persisted(harness, sessionId);
		expect(
			harness.marks
				.filter(
					(mark) => mark.kind === "runner-command" && mark.type === "send-turn",
				)
				.map((mark) => (mark.kind === "runner-command" ? mark.commandId : "")),
		).toEqual(commands.map((command) => command.command_id));
		expect(
			harness.marks.some(
				(mark) =>
					mark.kind === "runner-command" && mark.type === "answer-permission",
			),
		).toBe(true);
		const history = await browser.history(sessionId);
		expect(
			history
				.filter((message) => message.role === "user")
				.map((message) => message.text),
		).toEqual(["stream-parity", "warm-parity", "approval-parity"]);
		expect(
			history
				.filter((message) => message.role === "assistant")
				.map((message) =>
					message.parts?.map((part) => part.text ?? "").join(""),
				),
		).toEqual([
			responseChunks("stream-parity").join(""),
			responseChunks("warm-parity").join(""),
			responseChunks("approval-parity").join(""),
		]);
		mkdirSync("test-results/process-harness", { recursive: true });
		writeFileSync(
			`test-results/process-harness/85kb-8-${decision}-process-events.json`,
			JSON.stringify(
				{
					events,
					commands,
					normalized: normalize(events, harness.root),
					environment: normalize(query.env, harness.root),
				},
				null,
				2,
			),
		);
		await harness.dispose();
		await vi.waitFor(() => expect(() => process.kill(query.pid, 0)).toThrow(), {
			timeout: 5000,
		});
	}, 60_000);

	it("preserves the full history on an agent change in the default runner", async () => {
		const harness = await ProcessHarness.start();
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Agent change proof");
		await browser.send(sessionId, "history-before-agent-change");
		await settled(harness, sessionId, 1);
		await browser.switchAgent(sessionId, "reviewer");
		const turn = await browser.send(sessionId, "after-agent-change");
		expect(turn.chunks.join("")).toContain("history-before-agent-change");
		await settled(harness, sessionId, 2);
		const events = persisted(harness, sessionId).events;
		const prompts = harness.marks
			.filter((mark) => mark.kind === "enqueue")
			.map((mark) => (mark.kind === "enqueue" ? mark.prompt : ""));
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toBe("history-before-agent-change");
		expect(prompts[1]).toContain("history-before-agent-change");
		expect(prompts[1]).toContain("after-agent-change");
		expect(
			harness.marks.filter((mark) => mark.kind === "runner-started"),
		).toHaveLength(1);
		await harness.dispose();
		mkdirSync("test-results/process-harness", { recursive: true });
		writeFileSync(
			"test-results/process-harness/85kb-8-agent-change-events.json",
			JSON.stringify(
				{ events, normalized: normalize(events, harness.root), prompts },
				null,
				2,
			),
		);
	}, 60_000);

	it("bounds server shutdown when its runner is SIGSTOPped", async () => {
		const harness = await ProcessHarness.start();
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Stopped runner shutdown");
		await browser.send(sessionId, "before-runner-stop");
		await settled(harness, sessionId, 1);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		const server = harness.generations.at(-1);
		if (runner?.kind !== "runner-started" || !server)
			throw new Error("Missing runner/server proof");
		const boundMs = 15_000;
		const started = performance.now();
		process.kill(runner.pid, "SIGSTOP");
		try {
			await browser.shutdown();
			await vi.waitFor(
				() => {
					expect(server.exitCode).toBe(0);
					expect(() => process.kill(server.pid, 0)).toThrow();
					expect(() => process.kill(runner.pid, 0)).toThrow();
				},
				{ timeout: boundMs },
			);
			expect(performance.now() - started).toBeLessThan(boundMs);
			expect(existsSync(runner.socketPath)).toBe(false);
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				"test-results/process-harness/85kb-8-stopped-runner-shutdown.json",
				JSON.stringify(
					{ runner, server, boundMs, elapsedMs: performance.now() - started },
					null,
					2,
				),
			);
			// A failing regression must not leave a stopped child behind.
			try {
				process.kill(runner.pid, "SIGKILL");
			} catch {
				// Successful shutdown already reaped the child.
			}
		}
	}, 45_000);

	it("respawns a runner killed between turns and completes the next send", async () => {
		const harness = await ProcessHarness.start();
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Runner respawn proof");
		await browser.send(sessionId, "before-runner-exit");
		await settled(harness, sessionId, 1);
		const first = harness.marks.find((mark) => mark.kind === "runner-started");
		if (first?.kind !== "runner-started")
			throw new Error("Missing runner proof");
		process.kill(first.pid, "SIGKILL");
		await vi.waitFor(() => expect(() => process.kill(first.pid, 0)).toThrow(), {
			timeout: 5000,
		});
		try {
			const result = await browser.send(sessionId, "after-runner-exit");
			expect(result.chunks).toEqual(responseChunks("after-runner-exit"));
			await settled(harness, sessionId, 2);
			const runners = harness.marks.filter(
				(mark) => mark.kind === "runner-started",
			);
			expect(runners).toHaveLength(2);
			const second = runners.at(-1);
			if (second?.kind !== "runner-started")
				throw new Error("Missing replacement runner proof");
			expect(second.pid).not.toBe(first.pid);
			expect(existsSync(first.socketPath)).toBe(false);
			expect(
				harness.marks.filter((mark) => mark.kind === "query").at(-1),
			).toMatchObject({ pid: second.pid });
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				"test-results/process-harness/85kb-8-runner-respawn.json",
				JSON.stringify(
					{
						runners: harness.marks.filter(
							(mark) => mark.kind === "runner-started",
						),
						...persisted(harness, sessionId),
					},
					null,
					2,
				),
			);
		}
	}, 45_000);

	it("terminates the runner and removes its socket when a session is deleted", async () => {
		const harness = await ProcessHarness.start();
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Runner deletion proof");
		await browser.send(sessionId, "before-session-delete");
		await settled(harness, sessionId, 1);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing runner proof");
		const started = performance.now();
		try {
			await browser.deleteSession(sessionId);
			await vi.waitFor(
				() => expect(() => process.kill(runner.pid, 0)).toThrow(),
				{ timeout: 5000 },
			);
			expect(existsSync(runner.socketPath)).toBe(false);
			expect(harness.generations.at(-1)?.exitCode).toBeUndefined();
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				"test-results/process-harness/85kb-8-runner-deletion.json",
				JSON.stringify(
					{
						runner,
						elapsedMs: performance.now() - started,
						...persisted(harness, sessionId),
					},
					null,
					2,
				),
			);
		}
	}, 45_000);

	it.each([
		"interrupt",
		"interrupt-before-snapshot",
	] as const)("settles a notification-driven parent turn without a send waiter on %s", async (action) => {
		const harness = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
		});
		harnesses.push(harness);
		const browser = await harness.connect();
		await browser.setAutoSettle(null);
		const sessionId = await browser.createSession("Notification interrupt");
		const prompt =
			action === "interrupt-before-snapshot"
				? "notification-parent-turn-before-snapshot"
				: "notification-parent-turn";
		expect((await browser.send(sessionId, prompt)).chunks).toEqual(
			responseChunks(prompt),
		);
		await settled(harness, sessionId, 1);
		const runner = harness.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (runner?.kind !== "runner-started")
			throw new Error("Missing notification runner proof");
		writeFileSync(join(harness.root, "release-notification-parent"), "release");
		await vi.waitFor(() => {
			const state = persisted(harness, sessionId);
			expect(state.session.status).toBe("busy");
			expect(state.turns).toMatchObject([{ state: "running" }]);
			expect(
				state.events.some(
					(event) =>
						event.type === "text.delta" &&
						typeof event.data === "object" &&
						event.data !== null &&
						"text" in event.data &&
						event.data.text === "Notification parent message.",
				),
			).toBe(true);
		});
		const held = persisted(harness, sessionId);
		if (action === "interrupt-before-snapshot") {
			await vi.waitFor(() =>
				expect(
					sdkProof(harness).some(
						(mark) =>
							mark.kind === "notification-turn" && mark.phase === "stream-held",
					),
				).toBe(true),
			);
			const streamHeld = sdkProof(harness).find(
				(mark) =>
					mark.kind === "notification-turn" && mark.phase === "stream-held",
			);
			if (streamHeld?.kind !== "notification-turn")
				throw new Error("Missing pre-snapshot notification proof");
			expect(streamHeld.snapshotUuid).toEqual(expect.any(String));
			expect(streamHeld.snapshotUuid).not.toBe(streamHeld.messageId);
			expect(held.turns[0]?.assistant_message_id).toBe(streamHeld.messageId);
			expect(
				sdkProof(harness).filter(
					(mark) =>
						mark.kind === "notification-turn" && mark.phase === "snapshot",
				),
			).toEqual([]);
			expect(
				existsSync(join(harness.root, "release-notification-snapshot")),
			).toBe(false);
		}
		expect(held.commands).toEqual([
			{ command_id: expect.any(String), status: "completed" },
		]);
		const cancelCommandIds = [randomUUID(), randomUUID()];
		try {
			expect(new Set(cancelCommandIds).size).toBe(2);
			await Promise.all(
				cancelCommandIds.map((commandId) =>
					Effect.runPromise(
						browser.rpc.CancelSession({
							projectSlug: "process-test",
							sessionId,
							commandId,
						}),
					),
				),
			);
			await vi.waitFor(
				() => {
					const state = persisted(harness, sessionId);
					expect(state.session.status).toBe("idle");
					expect(state.turns).toMatchObject([{ state: "interrupted" }]);
					expect(state.turns[0]?.assistant_message_id).toBe(
						held.turns[0]?.assistant_message_id,
					);
					expect(state.commands).toEqual(held.commands);
					expect(
						state.events.filter((event) => event.type === "turn.interrupted"),
					).toEqual([
						expect.objectContaining({
							data: expect.objectContaining({
								messageId: held.turns[0]?.assistant_message_id,
							}),
						}),
					]);
					expect(
						state.events.filter((event) => event.type === "turn.completed"),
					).toHaveLength(1);
					expect(
						state.events.filter((event) => event.type === "turn.error"),
					).toEqual([]);
				},
				{ timeout: 10_000 },
			);
			const terminal = persisted(harness, sessionId);
			// Repeated browser cancellation cannot interrupt the completed first
			// turn or add another terminal event after notification cleanup.
			await Effect.runPromise(
				browser.rpc.CancelSession({
					projectSlug: "process-test",
					sessionId,
					commandId: randomUUID(),
				}),
			);
			expect(
				persisted(harness, sessionId).events.filter(
					(event) => event.type === "turn.interrupted",
				),
			).toHaveLength(1);
			await harness.kill();
			await harness.restart();
			await harness.connect(sessionId);
			expect(persisted(harness, sessionId)).toEqual(terminal);
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				`test-results/process-harness/nzjt-notification-${action}.json`,
				JSON.stringify(
					{
						action,
						cancelCommandIds,
						runner,
						held: normalize(held, harness.root),
						terminal: normalize(persisted(harness, sessionId), harness.root),
						process: harness.proof(),
						sdk: sdkProof(harness),
					},
					null,
					2,
				),
			);
		}
	}, 40_000);

	it("stops a runner waiting for approval and settles its unowned turn on restart", async () => {
		const harness = await ProcessHarness.start();
		harnesses.push(harness);
		const browser = await harness.connect();
		const sessionId = await browser.createSession("Shutdown proof");
		const pending = browser
			.send(sessionId, "approval-shutdown")
			.catch(() => undefined);
		await browser.waitFor(
			(message) => message["type"] === "permission_request",
		);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Missing runner proof");
		await browser.shutdown();
		await harness.waitForExit();
		await pending;
		await vi.waitFor(
			() => expect(() => process.kill(runner.pid, 0)).toThrow(),
			{ timeout: 5000 },
		);
		expect(existsSync(`${runner.socketPath}.json`)).toBe(false);
		// The disposed relay cannot acknowledge shutdown output. With the runner
		// gone, the next startup settles this turn through the ownership check.
		await harness.restart();
		const after = await harness.connect(sessionId);
		await vi
			.waitFor(
				() => {
					const { events, commands } = persisted(harness, sessionId);
					expect(commands.map((command) => command.status)).toEqual(["failed"]);
					expect(
						events.filter(
							(event) =>
								event.type === "turn.error" ||
								event.type === "turn.interrupted",
						),
					).toHaveLength(1);
					expect(
						events.some(
							(event) =>
								event.type === "session.status" &&
								typeof event.data === "object" &&
								event.data !== null &&
								"status" in event.data &&
								event.data.status === "idle",
						),
					).toBe(true);
				},
				{ timeout: 15_000 },
			)
			.finally(() => {
				mkdirSync("test-results/process-harness", { recursive: true });
				writeFileSync(
					"test-results/process-harness/85kb-8-shutdown-events.json",
					JSON.stringify(persisted(harness, sessionId), null, 2),
				);
			});
		const result = await after.send(sessionId, "after-explicit-approval-stop");
		expect(result.chunks).toEqual(
			responseChunks("after-explicit-approval-stop"),
		);
	}, 60_000);
});
