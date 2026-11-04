// Session-wide failures on the Run Ledger end to end (82tn.32.12; CONTRACT.md 3.4, 3.11 last
// bullet), over the isolated process harness. How it could fail (lane audit 19, 24-26):
// 19. a vanished native session loses the next message, or resumes the vanished session;
// 24. after a usage-limit failover the session stays busy or unusable, or the reason is hidden;
// 25. after a vanished native session the session stays busy, or the reason is hidden;
// 26. a usage limit ends the native session, so the continuation starts fresh.
// The continuation's own Run on the ledger (82tn.32.43; lane 3243 audit 1-4, 6, 7):
// 1. it is never admitted; 2. admitted but never ended; 3. ended twice; 4. the cut-off Run's end
// changes; 6, 7. its admission shows as a queued input, or a Stop could re-queue it as one.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

const TIMEOUT = 20_000;

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome, json_extract(entry_json, '$.reason') AS reason FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				runId: string;
				outcome: string | null;
				reason: string | null;
			}[],
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			entries: db
				.prepare(
					"SELECT json_extract(entry_json, '$.kind') AS kind, json_extract(entry_json, '$.runId') AS runId FROM run_ledger_entries WHERE session_id = ? ORDER BY entry_seq",
				)
				.all(sessionId) as { kind: string; runId: string | null }[],
			admitted: db
				.prepare(
					"SELECT json_extract(entry_json, '$.command.inputId') FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.command.verb') = 'admit' ORDER BY entry_seq",
				)
				.pluck()
				.all(sessionId) as string[],
			pending: db
				.prepare(
					"SELECT input_id FROM pending_inputs WHERE session_id = ? ORDER BY rowid",
				)
				.pluck()
				.all(sessionId) as string[],
			commands: db
				.prepare(
					"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.pluck()
				.all(sessionId) as string[],
			events: (
				db
					.prepare(
						"SELECT type, data FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as { type: string; data: string }[]
			).map(({ type, data }) => ({
				type,
				data: JSON.parse(data) as Record<string, unknown>,
			})),
		};
	} finally {
		db.close();
	}
};
const status = (events: { type: string; data: Record<string, unknown> }[]) =>
	events.filter(({ type }) => type === "session.status").at(-1)?.data["status"];

describe("Session-wide failures on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-12-session-wide-failure.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.12", proofs }, null, 2)}\n`,
		);
		writeFileSync(
			"test-results/82tn-32-43-failover-continuation.json",
			`${JSON.stringify(
				{
					ticket: "conduit-test-82tn.32.43",
					proofs: proofs.filter(
						({ case: name }) => name === "usage-limit-failover",
					),
				},
				null,
				2,
			)}\n`,
		);
	});

	it.each([
		1, 2, 3,
	])("leaves a vanished native session's session idle, shows why, and starts the next send fresh (%i)", async () => {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
		});
		harness = fixture;
		await fixture.restart();
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Vanished native session");
		await browser.send(sessionId, "before-vanish");
		const vanished = fixture.marks
			.filter((mark) => mark.kind === "query")
			.at(-1);
		if (vanished?.kind !== "query") throw new Error("Missing native session");
		// The provider forgets the native session, and the next send must resume it.
		writeFileSync(
			join(fixture.root, "rejected-resume-session-id"),
			vanished.sessionId,
		);
		for (const pid of fixture.remainingRunnerPids())
			process.kill(pid, "SIGKILL");
		// test-waits-allow polling: a runner's exit has no frame.
		await vi.waitFor(() => expect(fixture.remainingRunnerPids()).toEqual([]), {
			timeout: TIMEOUT,
			interval: 100,
		});
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: "after-vanish",
			}),
		);
		// test-waits-allow polling: the outcome reports through the store only.
		await vi.waitFor(
			() => {
				const { commands, events } = read(fixture, sessionId);
				expect(commands).toEqual(["completed", "failed"]);
				expect(status(events)).toBe("idle");
				expect(
					fixture.marks.some((mark) => mark.kind === "resume-rejected"),
				).toBe(true);
			},
			{ timeout: TIMEOUT, interval: 200 },
		);
		const failed = read(fixture, sessionId);
		const shown = failed.events.filter(({ type }) => type === "turn.error");
		expect(shown).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					error: expect.stringContaining("No conversation found"),
				}),
			}),
		]);
		const fresh = await browser.send(sessionId, "fresh-after-vanish");
		expect(fresh.chunks.join("")).toBe(
			responseChunks("fresh-after-vanish").join(""),
		);
		const next = fixture.marks.filter((mark) => mark.kind === "query").at(-1);
		if (next?.kind !== "query") throw new Error("Missing fresh native session");
		expect(next.sessionId).not.toBe(vanished.sessionId);
		expect(JSON.parse(next.optionsJson)).not.toHaveProperty("resume");
		const settled = read(fixture, sessionId);
		expect(settled.commands).toEqual(["completed", "failed", "completed"]);
		expect(status(settled.events)).toBe("idle");
		proofs.push({
			case: "vanished-native-session",
			sessionId,
			vanishedNativeSession: vanished.sessionId,
			freshNativeSession: next.sessionId,
			shownReason: shown.map(({ data }) => data["error"]),
			ends: settled.ends,
			commands: settled.commands,
			types: settled.events.map(({ type }) => type),
		});
	});

	it.each([
		1, 2, 3,
	])("leaves a usage-limited session idle with the limit shown, and continues it on another account (%i)", async () => {
		const fixture = await ProcessHarness.start({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "pong-thinking-text-turn"],
				usageLimitTurn: 1,
			},
		});
		harness = fixture;
		const socket = join(fixture.configDir, "relay.sock");
		const addAccount = async (name: string) => {
			const configDir = join(fixture.root, name.replace(" ", "-"));
			mkdirSync(configDir);
			const { addedInstanceId } = await sendRpcRequest(socket, {
				_tag: "AddInstance",
				name,
				driver: "claude",
				configDir,
			});
			if (!addedInstanceId) throw new Error(`Missing ${name}`);
			return addedInstanceId;
		};
		const limitedAccount = await addAccount("Limited account");
		const failoverAccount = await addAccount("Failover account");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Usage-limit failover",
			limitedAccount,
		);
		await sendRpcRequest(socket, {
			_tag: "input.submit",
			sessionId,
			inputId: randomUUID(),
			delivery: "queue",
			text: "Hit the limit.",
		});
		// test-waits-allow polling: the outcome reports through the store only.
		await vi.waitFor(
			() => {
				const { commands, events } = read(fixture, sessionId);
				expect(
					events.some(({ type }) => type === "session.usage_limited"),
				).toBe(true);
				expect(commands).toEqual(["completed"]);
				expect(status(events)).toBe("idle");
			},
			{ timeout: TIMEOUT, interval: 200 },
		);
		const limited = read(fixture, sessionId);
		const shown = limited.events.filter(
			({ type }) => type === "session.usage_limited",
		);
		await sendRpcRequest(socket, {
			_tag: "ContinueSession",
			sessionId,
			instanceId: failoverAccount,
			expectedInstanceId: limitedAccount,
		});
		// test-waits-allow polling: the outcome reports through the store only.
		await vi.waitFor(
			() => {
				const { commands, events } = read(fixture, sessionId);
				expect(events.some(({ type }) => type === "session.resumed")).toBe(
					true,
				);
				expect(commands).toEqual(["completed", "completed"]);
				expect(status(events)).toBe("idle");
			},
			{ timeout: TIMEOUT, interval: 200 },
		);
		const settled = read(fixture, sessionId);
		const [cutOffInput, continuedInput] = settled.events
			.filter(({ type }) => type === "input.sent")
			.map(({ data }) => data["inputId"]);
		// Each Run is admitted at its handoff and ends once by its result (CONTRACT.md 3.4, 3.9):
		// the cut-off one, and the continuation's on the same native session.
		expect(settled.admitted).toEqual([cutOffInput, continuedInput]);
		expect(settled.ends).toEqual(
			settled.runs.map(({ id }) => ({
				runId: id,
				outcome: "completed",
				reason: JSON.stringify({ tag: "completed" }),
			})),
		);
		expect(settled.runs).toHaveLength(2);
		// The continuation is no inbox input: it never shows in the queued tray, so nothing can
		// re-queue it as an empty message.
		expect(settled.pending).toEqual([cutOffInput]);
		// A usage limit ends no native session: the continuation resumes it.
		expect(settled.events.filter(({ type }) => type === "turn.error")).toEqual(
			[],
		);
		expect(
			fixture.claudeOptions().filter(({ prompt }) => prompt !== undefined),
		).toHaveLength(2);
		proofs.push({
			case: "usage-limit-failover",
			sessionId,
			limitedAccount,
			continuedOn: failoverAccount,
			continuedInput,
			admitted: settled.admitted,
			pendingInputs: settled.pending,
			entries: settled.entries,
			runs: settled.runs,
			shownReason: shown.map(({ data }) => data),
			ends: settled.ends,
			commands: settled.commands,
			types: settled.events.map(({ type }) => type),
		});
	});
});
