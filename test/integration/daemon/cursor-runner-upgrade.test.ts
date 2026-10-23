// Failure modes: old runners accept scoped credentials they ignore, active
// turns are killed at reattachment, or replacement waits for a build mismatch.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const scenarios: Record<string, unknown>[] = [];

afterEach(async ({ task }) => {
	if (!harness) return;
	await harness.dispose();
	scenarios.push({
		scenario: task.name,
		result: task.result?.state,
		failures: task.result?.errors?.map(({ message }) => message),
		proof: harness.proof(),
		remainingRunners: harness.remainingRunnerPids(),
	});
	writeFileSync(
		"/tmp/conduit-82tn9-5-runner-upgrade-fixed.json",
		JSON.stringify(scenarios, null, 2),
	);
	harness = undefined;
});

for (const active of [false, true]) {
	it(`replaces a legacy Cursor runner after ${active ? "draining its active turn" : "an idle restart"}`, async () => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			runnerLifecycle: {
				idleTimeoutMs: null,
				runnerHelloAfterFirst: true,
				runnerHelloWithoutCursorCredentials: true,
			},
		});
		const fixture = harness;
		const capture = join(fixture.root, "cursor-capture.jsonl");
		const gate = join(fixture.root, "stream.gate");
		if (active) writeFileSync(gate, "hold");
		const restart = () =>
			fixture.restart({
				startupTimeoutMs: 90_000,
				runnerStartupTimeoutMs: 90_000,
				serviceEnvironment: {
					CONDUIT_CURSOR_SDK_TRACE: resolve(
						"test/fixtures/cursor-sdk-traces/auth-login.jsonl",
					),
					CONDUIT_CURSOR_SDK_CAPTURE: capture,
					CURSOR_API_KEY: "[REDACTED:admitted-account]",
					CONDUIT_TEST_CURSOR_STREAM_GATE: gate,
				},
			});
		await restart();
		const added = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor upgrade",
			driver: "cursor",
		});
		if (!added.addedInstanceId) throw new Error("Missing Cursor account");
		let browser = await fixture.connect();
		const id = await browser.createSession(
			"Cursor upgrade",
			added.addedInstanceId,
			"cursor",
			{ modelId: "composer-2.5", contextWindow: "" },
		);
		const first = browser.send(id, "First turn", 90_000);
		const started = await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.sessionId === id,
		);
		if (started.kind !== "runner-started") throw new Error("Missing runner");
		const oldPid = started.pid;
		await vi.waitFor(
			() =>
				expect(
					existsSync(capture) &&
						readFileSync(capture, "utf8").includes('"send.options"'),
				).toBe(true),
			{ timeout: 30_000 },
		);
		if (!active) await first;
		// Killing only the fixture server preserves the detached, already-running runner.
		// Its next hello omits the new capability, while retaining the same build ID.
		const disconnected = first.catch(() => undefined);
		await fixture.kill();
		await restart();
		browser = await fixture.connect();
		const next = browser.send(id, "Scoped turn after restart", 90_000);
		if (active) {
			expect(() => process.kill(oldPid, 0)).not.toThrow();
			await setTimeout(150);
			expect(
				readFileSync(capture, "utf8").split('"send.options"'),
			).toHaveLength(2);
			rmSync(gate);
			await vi.waitFor(
				() => {
					expect(readFileSync(capture, "utf8")).toContain('"wait.result"');
				},
				{ timeout: 30_000 },
			);
		}
		const result = await next;
		expect(result.chunks.join("")).not.toBe("");
		await vi.waitFor(() => expect(() => process.kill(oldPid, 0)).toThrow(), {
			timeout: 30_000,
		});
		expect(
			fixture.marks.some(
				(mark) =>
					mark.kind === "runner-started" &&
					mark.sessionId === id &&
					mark.pid !== oldPid,
			),
		).toBe(true);
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			await vi.waitFor(() =>
				expect(
					db
						.prepare<[string], { state: string }>(
							"SELECT state FROM turns WHERE session_id = ? ORDER BY rowid",
						)
						.all(id)
						.map(({ state }) => state),
				).toEqual(["completed", "completed"]),
			);
		} finally {
			db.close();
		}
		await disconnected;
	}, 180_000);
}
