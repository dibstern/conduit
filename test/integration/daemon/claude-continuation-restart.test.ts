/*
 * conduit-test-f8ok: a server restart while a usage-limit continuation is
 * streaming replays its running outbox command into the adopted runner. By
 * then the continuation's own reply has cleared limit_recovery, so replay
 * planning must not treat the cut-off as closed. Failure modes:
 * - Replay planning refuses the continuation and fails a turn that the runner
 *   is still streaming, as a blank "Provider runtime error".
 * - Persisting that failure throws because startup has not wired WebSockets.
 * - Replay re-sends the continuation, so Claude sees the prompt twice.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

function persisted(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare(
					"SELECT sequence, type, data FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map((row) => {
					const event = row as { sequence: number; type: string; data: string };
					return {
						...event,
						data: JSON.parse(event.data) as Record<string, unknown>,
					};
				}),
			commands: db
				.prepare(
					"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.pluck()
				.all(sessionId) as string[],
		};
	} finally {
		db.close();
	}
}

describe("usage-limit continuation across a server restart", () => {
	let harness: ProcessHarness | undefined;
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it("keeps streaming a continuation whose reply already cleared the limit", async () => {
		harness = await ProcessHarness.start({
			dist: "dist",
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				usageLimitTurn: 1,
				holdBeforeResult: true,
			},
		});
		const fixture = harness;
		const release = join(fixture.root, "claude-replay-release");
		writeFileSync(release, "release\n");
		const socket = join(fixture.configDir, "relay.sock");
		const configDir = join(fixture.root, "continuation-account");
		mkdirSync(configDir);
		const { addedInstanceId } = await sendRpcRequest(socket, {
			_tag: "AddInstance",
			name: "Continuation account",
			driver: "claude",
			configDir,
		});
		if (!addedInstanceId) throw new Error("Missing continuation account");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Continuation across restart",
			addedInstanceId,
		);
		await sendRpcRequest(socket, {
			_tag: "input.submit",
			sessionId,
			inputId: randomUUID(),
			delivery: "queue",
			text: "Hit the limit.",
		});
		// The limit lands before its turn settles; continuing earlier is SessionBusy.
		await vi.waitFor(
			() => {
				const { events, commands } = persisted(fixture, sessionId);
				expect(
					events.some(({ type }) => type === "session.usage_limited"),
				).toBe(true);
				expect(commands).toEqual(["completed"]);
				expect(events.at(-1)).toMatchObject({
					type: "session.status",
					data: { status: "idle" },
				});
			},
			{ timeout: 15_000 },
		);

		rmSync(release);
		await sendRpcRequest(socket, {
			_tag: "ContinueSession",
			sessionId,
			instanceId: addedInstanceId,
			expectedInstanceId: addedInstanceId,
		});
		// The continuation's reply exists, and so has cleared limit_recovery,
		// while its result is still held: the command is running.
		await vi.waitFor(
			() => {
				const { events, commands } = persisted(fixture, sessionId);
				const resumed = events.find(({ type }) => type === "session.resumed");
				expect(resumed).toBeDefined();
				expect(
					events.some(
						({ sequence, type, data }) =>
							type === "message.created" &&
							data["role"] === "assistant" &&
							sequence > (resumed?.sequence ?? Infinity),
					),
				).toBe(true);
				expect(commands).toEqual(["completed", "running"]);
			},
			{ timeout: 15_000 },
		);

		await fixture.kill();
		await fixture.restart();
		await fixture.connect(sessionId);
		writeFileSync(release, "release\n");

		await vi.waitFor(
			() => {
				const { events, commands } = persisted(fixture, sessionId);
				expect(commands).toEqual(["completed", "completed"]);
				expect(events.at(-1)).toMatchObject({
					type: "session.status",
					data: { status: "idle" },
				});
			},
			{ timeout: 15_000 },
		);
		const { events } = persisted(fixture, sessionId);
		expect(events.filter(({ type }) => type === "turn.error")).toEqual([]);
		expect(
			fixture.claudeOptions().filter(({ prompt }) => prompt !== undefined),
		).toHaveLength(2);
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/f8ok-continuation-restart.json",
			JSON.stringify({ sessionId, events }, null, 2),
		);
	}, 60_000);
});
