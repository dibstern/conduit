// Measurement only: three SaveProject registrations, two new Claude sessions
// each, six simultaneous input.submit RPCs replaying the same recorded stream
// at 10 ms per frame. Latency runs from submit to the session-row turn-end
// notification, including RPC and runner startup. Percentiles use nearest rank.
// Daemon metrics accumulate from startup: eventLoopDelayMs is the 10 ms Node
// sampling histogram (including that interval); commitPermitWaitMs measures
// request-to-acquisition for each commit, including failed attempts; sqliteBusy
// counts failed commits with SQLITE_BUSY/SQLITE_BUSY_SNAPSHOT causes, once each.
// Wait for a fresh one-second flush, round milliseconds to 0.1, and write raw
// measurements to test-results/82tn6-contention.json. No performance thresholds.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import type { ProcessBrowser } from "../../helpers/process-harness.js";
import { expect, test } from "../helpers/process-harness-fixture.js";

// The longest existing single-input, single-result harness trace by streaming
// delta count: 52 deltas in 87 frames, without steering or a second input.
const fixture = "background-shell-ends-between-turns";
test.use({
	harnessOptions: { claudeReplay: { turns: [fixture], delayMs: 10 } },
});
test.beforeEach(({ isMobile }) => {
	test.skip(isMobile, "Store contention is measured once on desktop");
});

test("measures writes across three projects during six streaming turns", async ({
	harness,
}, testInfo) => {
	test.setTimeout(120_000);
	const metricsFile = join(harness.root, "contention-metrics.json");
	await harness.terminate();
	await harness.restart({
		serviceEnvironment: { CONDUIT_CONTENTION_METRICS: metricsFile },
	});
	const control = await harness.connect(undefined, undefined, undefined, false);
	const turns: { browser: ProcessBrowser; sessionId: string }[] = [];
	for (let project = 0; project < 3; project++) {
		const folder = join(harness.root, `contention-project-${project}`);
		mkdirSync(folder);
		const { savedSlug } = await Effect.runPromise(
			control.rpc.SaveProject({
				title: `Contention project ${project}`,
				folders: [folder],
			}),
		);
		if (!savedSlug) throw new Error("SaveProject omitted the project slug");
		const browser = await harness.connect(
			undefined,
			undefined,
			savedSlug,
			false,
		);
		for (let turn = 0; turn < 2; turn++) {
			const sessionId = await browser.createSession(`Contention turn ${turn}`);
			turns.push({ browser, sessionId });
		}
	}

	const latencies = await Promise.all(
		turns.map(async ({ browser, sessionId }) => {
			const cursor = browser.frames.length;
			const completion = browser
				.waitForTurnEnd(sessionId, cursor, 60_000)
				.then((done) => ({ done, completedAt: performance.now() }));
			const started = performance.now();
			// Use the send RPC directly so history reads in browser.send are not timed.
			const [submitted, { done, completedAt }] = await Promise.all([
				Effect.runPromise(
					browser.rpc.input
						.submit({
							sessionId,
							originId: browser.originId,
							inputId: randomUUID(),
							delivery: "queue",
							text: "Run the recorded streaming turn.",
						})
						.pipe(Effect.timeout(60_000)),
				),
				completion,
			]);
			if (!submitted.ok) throw new Error(`Submit refused: ${submitted.reason}`);
			expect(done["status"]).toBe("idle");
			return completedAt - started;
		}),
	);
	const completedAt = Date.now();
	await expect
		.poll(() => (existsSync(metricsFile) ? statSync(metricsFile).mtimeMs : 0), {
			timeout: 10_000,
		})
		.toBeGreaterThan(completedAt + 1_000);
	const metrics: {
		eventLoopDelayMs: {
			min: number;
			mean: number;
			p50: number;
			p99: number;
			max: number;
		};
		commitPermitWaitMs: {
			count: number;
			p50: number;
			p99: number;
			max: number;
		};
		sqliteBusy: number;
	} = JSON.parse(readFileSync(metricsFile, "utf8"));
	expect(metrics).toEqual({
		eventLoopDelayMs: {
			min: expect.any(Number),
			mean: expect.any(Number),
			p50: expect.any(Number),
			p99: expect.any(Number),
			max: expect.any(Number),
		},
		commitPermitWaitMs: {
			count: expect.any(Number),
			p50: expect.any(Number),
			p99: expect.any(Number),
			max: expect.any(Number),
		},
		sqliteBusy: expect.any(Number),
	});
	latencies.sort((a, b) => a - b);
	const round = (ms: number) => Math.round(ms * 10) / 10;
	const percentile = (p: number) =>
		round(latencies[Math.ceil((p / 100) * latencies.length) - 1] ?? 0);
	const artifact = resolve("test-results/82tn6-contention.json");
	expect(existsSync(harness.daemonStorePath())).toBe(true);
	mkdirSync(resolve("test-results"), { recursive: true });
	writeFileSync(
		artifact,
		`${JSON.stringify(
			{
				storeModel: "shared",
				projects: 3,
				turnsPerProject: 2,
				fixture,
				turnLatencyMs: {
					p50: percentile(50),
					p99: percentile(99),
					max: percentile(100),
				},
				...metrics,
			},
			null,
			2,
		)}\n`,
	);
	await testInfo.attach("store-contention", {
		path: artifact,
		contentType: "application/json",
	});
});
