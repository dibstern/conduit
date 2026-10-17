import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import type { TurnTimelineRecord } from "../../../src/lib/domain/daemon/Services/turn-timeline.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Failure cases: queued admission being reset at dispatch, duplicate/retried
// frames, subagent output attributed to the parent, and publication racing the
// commit mark. The record must close on the actual browser socket write.
let harness: ProcessHarness | undefined;

const readTimelines = (tracePath: string, sessionId: string) =>
	existsSync(tracePath)
		? readFileSync(tracePath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as TurnTimelineRecord)
				.filter(
					(record) =>
						record.type === "turn-timeline" && record.sessionId === sessionId,
				)
		: [];

afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

it("records one admitted-to-socket timeline through the fake Claude process", async () => {
	harness = await ProcessHarness.start();
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Turn timeline");
	const prompt = "stream-parity";
	expect((await browser.send(sessionId, prompt)).chunks.join("")).toBe(
		responseChunks(prompt).join(""),
	);
	const tracePath = join(harness.root, "config", "logs", "server.trace.ndjson");
	await vi.waitFor(
		() => expect(readTimelines(tracePath, sessionId)).toHaveLength(1),
		{
			timeout: 5_000,
		},
	);
	const record = readTimelines(tracePath, sessionId)[0];
	expect(record).toBeDefined();
	if (!record) throw new Error("Missing turn timeline");
	expect(record.closedBy).toBe("first-socket-write");
	expect(record.missingPhases).toEqual([]);
	expect(record.phases.map((entry) => entry.phase)).toEqual([
		"admitted",
		"reactor-start",
		"history-ready",
		"runner-ready",
		"prompt-delivered",
		"first-frame-received",
		"first-delta-committed",
		"first-socket-write",
	]);
	let previous = 0;
	for (const phase of record.phases) {
		expect(phase.elapsedMs).toBeGreaterThanOrEqual(previous);
		expect(phase.deltaMs).toBeCloseTo(phase.elapsedMs - previous, 5);
		previous = phase.elapsedMs;
	}
	expect(record.durationMs).toBeGreaterThanOrEqual(previous);
	for (const phase of record.phases.filter((entry) =>
		["runner-ready", "prompt-delivered"].includes(entry.phase),
	))
		expect(phase.approximation).toBe("first-frame-received");
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const admitted = db
			.prepare(
				"SELECT json_extract(data, '$.inputId') AS inputId FROM events WHERE session_id = ? AND type = 'input.admitted'",
			)
			.all(sessionId);
		expect(admitted).toEqual([{ inputId: record.inputId }]);
	} finally {
		db.close();
	}
	// Force tracing cleanup to flush later frames before checking duplicate closes.
	await harness.terminate();
	expect(readTimelines(tracePath, sessionId)).toHaveLength(1);
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/8rdf-20-turn-timeline.json",
		JSON.stringify(
			{
				record,
				timelineRecordCount: readTimelines(tracePath, sessionId).length,
			},
			null,
			2,
		),
	);
});

it("leaves socket write missing when the browser leaves before assistant output", async () => {
	harness = await ProcessHarness.start({ queryInitializationDelayMs: 500 });
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Unobserved turn timeline");
	await browser.followSession(sessionId);
	const inputId = randomUUID();
	expect(
		await Effect.runPromise(
			browser.rpc.input.submit({
				sessionId,
				originId: "timeline-disconnect",
				inputId,
				delivery: "queue",
				text: "stream-parity",
			}),
		),
	).toMatchObject({ ok: true });
	await browser.close();
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		await vi.waitFor(
			() => {
				const completed = db
					.prepare(
						"SELECT COUNT(*) AS n FROM provider_command_outbox WHERE project_key = 'process-test' AND command_id = ? AND status = 'completed'",
					)
					.get(inputId);
				expect(completed).toEqual({ n: 1 });
			},
			{ timeout: 5_000 },
		);
	} finally {
		db.close();
	}
	await harness.terminate();
	const records = readTimelines(
		join(harness.root, "config", "logs", "server.trace.ndjson"),
		sessionId,
	);
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({
		inputId,
		closedBy: "timeout",
		timeoutReason: "shutdown",
		missingPhases: ["first-socket-write"],
	});
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/8rdf-20-unobserved-turn-timeline.json",
		JSON.stringify(records[0], null, 2),
	);
});
