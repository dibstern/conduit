import { randomUUID } from "node:crypto";
import { accessSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { join, resolve } from "node:path";
import type { HistoryMessage } from "../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../helpers/process-harness.js";

const SENDS = 200;
const WARMUP = 10;
const BATCHES = 5;
const MAX_P99_REGRESSION_MS = 2;

function percentile(samples: number[], quantile: number): number {
	if (
		samples.length === 0 ||
		samples.some((sample) => !Number.isFinite(sample) || sample < 0)
	) {
		throw new Error("Missing, negative, or invalid latency samples");
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
}

async function measureBatch(
	harness: ProcessHarness,
	browser: ProcessBrowser,
	sessionId: string,
	prefix: string,
) {
	const markStart = harness.marks.length;
	const frameStart = browser.frames.length;
	const prompts: string[] = [];
	for (let index = 0; index < SENDS; index++) {
		const prompt = `${prefix}-send-${index}`;
		prompts.push(prompt);
		const turnCursor = browser.frames.length;
		const response = await browser.send(sessionId, prompt);
		if (response.chunks.join("") !== responseChunks(prompt).join("")) {
			throw new Error(`Stream mismatch for ${prompt}`);
		}
		await browser.waitFor(
			(message) =>
				message["type"] === "transcript_message" &&
				message["role"] === "assistant" &&
				message["sessionId"] === sessionId &&
				(message["parts"] as HistoryMessage["parts"])
					?.filter((part) => part.type === "text")
					.map((part) => part.text ?? "")
					.join("") === responseChunks(prompt).join(""),
			turnCursor,
		);
	}
	// IPC and WS are independent channels. Wait for all marks rather than
	// assuming that a browser completion frame also drained the IPC pipe.
	const deadline = Date.now() + 5000;
	const promptSet = new Set(prompts);
	while (
		harness.marks
			.slice(markStart)
			.filter((mark) => mark.kind === "enqueue" && promptSet.has(mark.prompt))
			.length < SENDS ||
		harness.marks
			.slice(markStart)
			.filter((mark) => mark.kind === "emit" && promptSet.has(mark.prompt))
			.length <
			SENDS * 3
	) {
		if (Date.now() > deadline)
			throw new Error("Timed out waiting for SDK timing marks");
		await new Promise<void>((done) => setImmediate(done));
	}
	if (harness.marks.filter((mark) => mark.kind === "query").length !== 1) {
		throw new Error("Benchmark did not keep exactly one warm SDK query");
	}
	const enqueue: number[] = [];
	const forward: number[] = [];
	const marks = harness.marks.slice(markStart);
	const batchFrames = browser.frames.slice(frameStart);
	for (const prompt of prompts) {
		const receipts = marks.filter(
			(mark) => mark.kind === "receipt" && mark.prompt === prompt,
		);
		const enqueues = marks.filter(
			(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
		);
		const receipt = receipts[0];
		const received = enqueues[0];
		if (
			receipts.length !== 1 ||
			enqueues.length !== 1 ||
			receipt?.kind !== "receipt" ||
			received?.kind !== "enqueue"
		) {
			throw new Error(
				`Expected one RPC receipt and one SDK enqueue for ${prompt}`,
			);
		}
		enqueue.push(Number(BigInt(received.at) - BigInt(receipt.at)) / 1e6);
		let projectedText = "";
		for (const text of responseChunks(prompt)) {
			projectedText += text;
			const emissions = marks.filter(
				(mark) =>
					mark.kind === "emit" && mark.prompt === prompt && mark.text === text,
			);
			const emission = emissions[0];
			if (emissions.length !== 1 || emission?.kind !== "emit")
				throw new Error(`Expected one SDK emission for ${text}`);
			const frame = batchFrames.find(
				({ message }) =>
					message["type"] === "transcript_message" &&
					message["role"] === "assistant" &&
					message["sessionId"] === sessionId &&
					(message["parts"] as HistoryMessage["parts"])
						?.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join("")
						.includes(projectedText),
			);
			if (!frame)
				throw new Error(`Missing browser transcript projection for ${text}`);
			forward.push(Number(frame.at - BigInt(emission.at)) / 1e6);
		}
	}
	return {
		sends: SENDS,
		enqueue: {
			count: enqueue.length,
			p50: percentile(enqueue, 0.5),
			p99: percentile(enqueue, 0.99),
			samples: enqueue,
		},
		forward: {
			count: forward.length,
			p50: percentile(forward, 0.5),
			p99: percentile(forward, 0.99),
			samples: forward,
		},
	};
}

async function main(): Promise<void> {
	const options: Record<string, string> = {};
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		console.log(
			"Usage: pnpm bench:send-path [--dist <baseline dist>] [--candidate <candidate dist>] [--output <results.json>]\n5 alternating 200-send batches per build after 10 warmup sends; compare median batch p99s with a +2ms gate. Each build uses its default runner path.",
		);
		return;
	}
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (
			!key ||
			!["--dist", "--candidate", "--output"].includes(key) ||
			!value ||
			value.startsWith("--") ||
			options[key]
		) {
			throw new Error(
				"Expected --dist <directory>, --candidate <directory>, or --output <file>; use --help",
			);
		}
		options[key] = resolve(value);
	}
	const dist = options["--dist"] ?? resolve("dist");
	for (const build of [dist, options["--candidate"]].filter(
		(path): path is string => path !== undefined,
	)) {
		accessSync(
			join(build, "src/lib/domain/daemon/Layers/daemon-foreground.js"),
		);
		accessSync(join(build, "src/lib/server/ws-rpc-handler.js"));
	}
	const machine = {
		platform: platform(),
		release: release(),
		arch: arch(),
		cpu: cpus()[0]?.model,
		node: process.version,
	};
	console.log(`Machine: ${JSON.stringify(machine)}`);
	const method = {
		transport: "typed-rpc-read-model",
		forwardMetric: "sdk-emission-to-first-projection-containing-text",
		rawDeltaTimingAvailable: false,
		batchesPerBuild: BATCHES,
		sendsPerBatch: SENDS,
		warmupPerBuild: WARMUP,
		order: options["--candidate"]
			? "baseline/candidate alternating"
			: "baseline sequential",
		summary: "median of per-batch nearest-rank p50/p99",
		maxP99RegressionMs: MAX_P99_REGRESSION_MS,
	};
	console.log(
		`Method: ${BATCHES} batches/build, ${SENDS} sends/batch, ${method.order}; median batch p50/p99`,
	);
	const harnesses: ProcessHarness[] = [];
	const builds: Array<{
		dist: string;
		runnerMode: "process" | "in-process";
		sessionId: string;
		prefix: string;
		harness: ProcessHarness;
		browser: ProcessBrowser;
		batches: Array<Awaited<ReturnType<typeof measureBatch>>>;
	}> = [];
	try {
		// Confirm both factories before sending any warmup prompts. A stale
		// candidate must fail closed even when the baseline is compatible.
		for (const buildDist of [dist, options["--candidate"]]) {
			if (!buildDist) continue;
			const harness = await ProcessHarness.start({
				dist: buildDist,
			});
			harnesses.push(harness);
			const browser = await harness.connect();
			builds.push({
				dist: buildDist,
				runnerMode: "in-process",
				harness,
				browser,
				sessionId: await browser.createSession(),
				prefix: randomUUID(),
				batches: [],
			});
		}
		for (const build of builds) {
			for (let index = 0; index < WARMUP; index++)
				await build.browser.send(
					build.sessionId,
					`${build.prefix}-warmup-${index}`,
				);
			const runner = build.harness.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			const query = build.harness.marks.find((mark) => mark.kind === "query");
			const serverPid = build.harness.generations[0]?.pid;
			if (query?.kind !== "query" || serverPid === undefined)
				throw new Error("SDK query activation was not acknowledged");
			if (runner || query.pid !== serverPid) {
				if (
					runner?.kind !== "runner-started" ||
					query.pid !== runner.pid ||
					query.pid === serverPid
				)
					throw new Error("Process runner activation was not acknowledged");
				build.runnerMode = "process";
			}
		}
		for (let index = 0; index < BATCHES; index++) {
			for (const [buildIndex, build] of builds.entries()) {
				const batch = await measureBatch(
					build.harness,
					build.browser,
					build.sessionId,
					`${build.prefix}-batch-${index}`,
				);
				build.batches.push(batch);
				console.log(
					`batch ${index + 1} ${buildIndex === 0 ? "baseline" : "candidate"}: enqueue p99=${batch.enqueue.p99.toFixed(3)}ms projection-forward p99=${batch.forward.p99.toFixed(3)}ms`,
				);
			}
		}
	} finally {
		for (const harness of harnesses) await harness.dispose();
	}
	const summaries = builds.map((build) => {
		const summarize = (key: "enqueue" | "forward") => ({
			count: build.batches.reduce(
				(count, batch) => count + batch[key].count,
				0,
			),
			p50: percentile(
				build.batches.map((batch) => batch[key].p50),
				0.5,
			),
			p99: percentile(
				build.batches.map((batch) => batch[key].p99),
				0.5,
			),
			batchP99s: build.batches.map((batch) => batch[key].p99),
		});
		return {
			dist: build.dist,
			runnerMode: build.runnerMode,
			runners: build.harness.marks.filter(
				(mark) => mark.kind === "runner-started",
			),
			sessionId: build.sessionId,
			warmup: WARMUP,
			sends: SENDS * BATCHES,
			enqueue: summarize("enqueue"),
			forward: summarize("forward"),
			batches: build.batches,
		};
	});
	const baseline = summaries[0];
	const candidate = summaries[1];
	if (!baseline) throw new Error("Missing baseline measurements");
	const results = {
		date: new Date().toISOString(),
		machine,
		method,
		baseline,
		candidate,
	};
	if (options["--output"])
		writeFileSync(options["--output"], `${JSON.stringify(results, null, 2)}\n`);
	for (const [label, result] of [
		["baseline", baseline],
		["candidate", candidate],
	] as const) {
		if (!result) continue;
		console.log(`${label}: ${result.dist}`);
		console.log(
			`  warmup=${result.warmup} batches=${result.batches.length} sends=${result.sends} events=${result.forward.count}`,
		);
		console.log(
			`  send-to-provider-enqueue p50=${result.enqueue.p50.toFixed(3)}ms p99=${result.enqueue.p99.toFixed(3)}ms`,
		);
		console.log(
			`  projection-forward p50=${result.forward.p50.toFixed(3)}ms p99=${result.forward.p99.toFixed(3)}ms`,
		);
	}
	if (candidate) {
		let regressed = false;
		for (const [key, label] of [
			["enqueue", "send-to-provider-enqueue"],
			["forward", "projection-forward"],
		] as const) {
			const delta = candidate[key].p99 - baseline[key].p99;
			const failed = delta > MAX_P99_REGRESSION_MS;
			regressed ||= failed;
			console.log(
				`${failed ? "FAIL" : "PASS"} ${label}: median batch p99 delta=${delta.toFixed(3)}ms, allowed=+${MAX_P99_REGRESSION_MS}ms`,
			);
		}
		if (regressed) process.exitCode = 1;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
