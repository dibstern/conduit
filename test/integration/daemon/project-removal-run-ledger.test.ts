// Removing a project on the Run Ledger end to end (82tn.32.12; CONTRACT.md 3.11 H4), over the
// isolated process harness and the fake Claude SDK. How it could fail (lane audit 1, 12, 14, 17,
// 20-22):
// 1. a send to the removed project reaches the agent after its removal finished;
// 12. a send that already reached the agent is refused, so its Run ends refused while it runs;
// 14. a spawn racing removal survives it, leaving a live runner for the removed project;
// 17. removing one project delays or reorders another project's sends;
// 20. the running Run never ends, or ends twice;
// 21. the other project's runs are cancelled, refused or reordered;
// 22. a restart after the removal resumes or re-refuses the removed project's sends.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const TIMEOUT = 25_000;

const read = (harness: ProcessHarness, sessionId: string) => {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			ends: db
				.prepare(
					"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome, json_extract(entry_json, '$.reason.tag') AS reason, json_extract(entry_json, '$.reason.code') AS code FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end' ORDER BY entry_seq",
				)
				.all(sessionId) as {
				runId: string;
				outcome: string | null;
				reason: string | null;
				code: string | null;
			}[],
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY rowid",
				)
				.all(sessionId) as { id: string; status: string }[],
			sends: db
				.prepare(
					"SELECT o.command_id AS commandId, o.run_id AS runId, o.status, o.error_code AS code, r.error FROM provider_command_outbox o LEFT JOIN command_receipts r ON r.command_id = o.command_id WHERE o.session_id = ? AND o.effect_type = 'send_turn' ORDER BY o.request_sequence",
				)
				.all(sessionId) as {
				commandId: string;
				runId: string;
				status: string;
				code: string | null;
				error: string | null;
			}[],
			queue: db
				.prepare(
					"SELECT text, state FROM pending_inputs WHERE session_id = ? AND state <> 'removed' ORDER BY rowid",
				)
				.all(sessionId) as { text: string; state: string }[],
			types: (
				db
					.prepare(
						"SELECT type FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId) as { type: string }[]
			).map(({ type }) => type),
		};
	} finally {
		db.close();
	}
};

describe("Removing a project on the Run Ledger", () => {
	let harness: ProcessHarness | undefined;
	const proofs: Record<string, unknown>[] = [];
	afterEach(async () => {
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/82tn-32-12-project-removal.json",
			`${JSON.stringify({ ticket: "conduit-test-82tn.32.12", proofs }, null, 2)}\n`,
		);
	});

	const start = async (serviceEnvironment: Record<string, string> = {}) => {
		const fixture = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			restartProof: true,
		});
		harness = fixture;
		await fixture.restart({ serviceEnvironment });
		const browser = await fixture.connect();
		await browser.setAutoSettle(null);
		return { fixture, browser };
	};
	const submit = (browser: ProcessBrowser, sessionId: string, text: string) =>
		Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text,
			}),
		);
	const remove = (browser: ProcessBrowser) =>
		Effect.runPromise(browser.rpc.RemoveProject({ slug: "process-test" }));
	const enqueued = (fixture: ProcessHarness) =>
		fixture.marks.flatMap((mark) =>
			mark.kind === "enqueue" ? [mark.request] : [],
		);

	it.each([
		1, 2, 3,
	])("leaves no live runner and sends nothing when removal meets a spawn in flight (%i)", async () => {
		const { fixture, browser } = await start({
			CONDUIT_TEST_RUNNER_LISTEN_DELAY_MS: "400",
		});
		const sessionId = await browser.createSession("Removal during spawn");
		const prompt = "removal-during-spawn";
		await submit(browser, sessionId, prompt);
		await fixture.waitForMark((mark) => mark.kind === "runner-spawned");
		// The runner is not yet discoverable: removal's runner sweep cannot see it.
		await remove(browser);
		// Past the listen delay, its registration and the daemon's attach.
		// test-waits-allow polling: the outcome reports through the store only.
		await vi.waitFor(
			() =>
				expect(read(fixture, sessionId).sends).toEqual([
					expect.objectContaining({
						status: "cancelled",
						code: "project_inactive",
						error: expect.stringContaining("project_inactive"),
					}),
				]),
			{ timeout: TIMEOUT, interval: 200 },
		);
		const removedAt = Date.now();
		const seen: { at: number; live: number[] }[] = [];
		// test-waits-allow polling: a runner's exit has no frame.
		await vi.waitFor(
			() => {
				seen.push({
					at: Date.now() - removedAt,
					live: fixture.remainingRunnerPids(),
				});
				expect(fixture.remainingRunnerPids()).toEqual([]);
			},
			{ timeout: TIMEOUT, interval: 100 },
		);
		expect(enqueued(fixture)).not.toContain(prompt);
		const ledger = read(fixture, sessionId);
		// The cut-short try showed nothing: one Run, ended by its one refusal.
		expect(ledger.runs).toEqual([expect.objectContaining({ status: "error" })]);
		expect(ledger.types.filter((type) => type === "turn.error")).toHaveLength(
			1,
		);
		proofs.push({
			case: "removal-during-spawn",
			sessionId,
			runnerPids: fixture.runnerPids(),
			seen,
			...ledger,
		});
	});
});
