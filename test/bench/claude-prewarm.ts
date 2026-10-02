import { randomUUID } from "node:crypto";
import { accessSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	type ProcessBrowser,
	ProcessHarness,
	responseChunks,
} from "../helpers/process-harness.js";

function percentile(samples: number[], quantile: number): number {
	if (
		!samples.length ||
		samples.some((value) => !Number.isFinite(value) || value < 0)
	)
		throw new Error("Missing or invalid timing samples");
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * quantile) - 1] ?? 0;
}

function summary(samples: number[]) {
	return {
		count: samples.length,
		p50: percentile(samples, 0.5),
		p99: percentile(samples, 0.99),
		samples,
	};
}

async function waitUntil(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error(`Timed out waiting for ${description}`);
		await new Promise<void>((done) => setTimeout(done, 5));
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function measureFirstSend(
	harness: ProcessHarness,
	browser: ProcessBrowser,
	prewarm: boolean,
	batch: number,
	round: number,
) {
	const sessionId = await browser.createSession("First-send benchmark");
	const markStart = harness.marks.length;
	let preWarmMs: number | undefined;
	let repeatPreWarmMs: number | undefined;
	if (prewarm) {
		const started = performance.now();
		await browser.preWarmSession(sessionId);
		preWarmMs = performance.now() - started;
		await waitUntil(
			() =>
				harness.marks
					.slice(markStart)
					.some((mark) => mark.kind === "initialization-ready"),
			"warm initialization proof",
		);
		if (
			harness.marks
				.slice(markStart)
				.some((mark) => mark.kind === "enqueue" || mark.kind === "system-init")
		)
			throw new Error(
				"Pre-warm sent a prompt or emitted system/init before input",
			);
		const repeated = performance.now();
		await browser.preWarmSession(sessionId);
		repeatPreWarmMs = performance.now() - repeated;
	} else if (
		harness.marks.slice(markStart).some((mark) => mark.kind === "query")
	) {
		throw new Error("Cold first-send session already had a query");
	}
	const prompt = `first-send-${randomUUID()}`;
	const frameStart = browser.frames.length;
	const clientSendAt = process.hrtime.bigint();
	const response = await browser.send(sessionId, prompt);
	if (
		response.done["code"] !== 0 ||
		response.chunks.join("") !== responseChunks(prompt).join("")
	)
		throw new Error(`First-send stream mismatch for ${prompt}`);
	await waitUntil(
		() =>
			harness.marks
				.slice(markStart)
				.some((mark) => mark.kind === "enqueue" && mark.prompt === prompt),
		"SDK enqueue timing proof",
	);
	const marks = harness.marks.slice(markStart);
	const query = marks.find((mark) => mark.kind === "query");
	const ready = marks.find((mark) => mark.kind === "initialization-ready");
	const receipt = marks.find(
		(mark) => mark.kind === "receipt" && mark.prompt === prompt,
	);
	const enqueue = marks.find(
		(mark) => mark.kind === "enqueue" && mark.prompt === prompt,
	);
	const runner = marks.find((mark) => mark.kind === "runner-started");
	const firstChunk = browser.frames
		.slice(frameStart)
		.find(
			({ message }) =>
				message["type"] === "delta" &&
				message["text"] === responseChunks(prompt)[0],
		);
	if (
		query?.kind !== "query" ||
		ready?.kind !== "initialization-ready" ||
		receipt?.kind !== "receipt" ||
		enqueue?.kind !== "enqueue" ||
		!firstChunk
	)
		throw new Error("Missing first-send query/readiness/RPC/browser evidence");
	if (
		marks.filter((mark) => mark.kind === "query").length !== 1 ||
		marks.filter((mark) => mark.kind === "enqueue").length !== 1 ||
		enqueue.queryId !== query.queryId ||
		ready.queryId !== query.queryId ||
		enqueue.promptIndex !== 1
	)
		throw new Error("First send did not use exactly one initialized SDK query");
	const serverPid = harness.generations.at(-1)?.pid;
	if (
		prewarm &&
		(runner?.kind !== "runner-started" ||
			runner.pid !== query.pid ||
			query.pid === serverPid)
	)
		throw new Error(
			"Warm first send did not reuse the initialized runner process",
		);
	const sample = {
		batch,
		round,
		sessionId,
		prompt,
		queryId: query.queryId,
		pid: query.pid,
		clientSendAt: clientSendAt.toString(),
		receiptAt: receipt.at,
		enqueueAt: enqueue.at,
		queryAt: query.at,
		initializedAt: ready.at,
		initializationMs: Number(BigInt(ready.at) - BigInt(query.at)) / 1e6,
		sendToEnqueueMs: Number(BigInt(enqueue.at) - BigInt(receipt.at)) / 1e6,
		clientToFirstChunkMs: Number(firstChunk.at - clientSendAt) / 1e6,
		...(preWarmMs !== undefined ? { preWarmMs, repeatPreWarmMs } : {}),
	};
	await browser.deleteSession(sessionId);
	if (runner?.kind === "runner-started") {
		await waitUntil(() => !alive(runner.pid), "session runner cleanup");
		if (existsSync(runner.socketPath))
			throw new Error("Deleted session left a runner socket");
	}
	return sample;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		console.log(
			"Usage: node --import tsx test/bench/claude-prewarm.ts [--dist dist] [--output test-results/85kb-14-prewarm.json] [--initialization-ms 250] [--batches 5] [--sessions 8]\nUses fresh sessions, rotating mode order, and a synthetic one-time initialization delay. Gate: warm p50, p99 and median batch p99 <= cold in-process baseline, with no latency allowance.",
		);
		return;
	}
	const options: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		const value = args[index + 1];
		if (
			!key ||
			![
				"--dist",
				"--output",
				"--initialization-ms",
				"--batches",
				"--sessions",
			].includes(key) ||
			!value ||
			value.startsWith("--") ||
			options[key]
		)
			throw new Error(
				"Expected --dist, --output, --initialization-ms, --batches, or --sessions with a value; use --help",
			);
		options[key] = value;
	}
	const dist = resolve(options["--dist"] ?? "dist");
	const output = resolve(
		options["--output"] ?? "test-results/85kb-14-prewarm.json",
	);
	const initializationMs = Number(options["--initialization-ms"] ?? 250);
	const batches = Number(options["--batches"] ?? 5);
	const sessions = Number(options["--sessions"] ?? 8);
	if (
		!Number.isInteger(initializationMs) ||
		initializationMs < 1 ||
		!Number.isInteger(batches) ||
		batches < 1 ||
		!Number.isInteger(sessions) ||
		sessions < 1
	)
		throw new Error(
			"Initialization delay, batches, and sessions must be positive integers",
		);
	accessSync(join(dist, "src/lib/domain/daemon/Layers/daemon-foreground.js"));
	accessSync(join(dist, "src/lib/server/ws-rpc-handler.js"));
	const machine = {
		platform: platform(),
		release: release(),
		arch: arch(),
		cpu: cpus()[0]?.model,
		node: process.version,
	};
	const method = {
		batches,
		freshSessionsPerBatchPerMode: sessions,
		initializationMs,
		order:
			"rotate cold-in-process/cold-process/prewarmed-process per fresh-session round",
		metric: "RPC receipt to fake SDK prompt consumption after initialization",
		summary: "nearest-rank p50/p99 raw distribution and median per-batch p99",
		gate: "prewarmed p50, p99 and median batch p99 <= cold in-process; no allowance",
		limitations:
			"Synthetic initialization cost, fake inference, ephemeral loopback daemon, no real Claude CLI/auth/MCP or remote model latency. This measures the real built-dist runner/RPC paths with test SDK injection, not production boot savings.",
	};
	console.log(`Machine: ${JSON.stringify(machine)}`);
	console.log(
		`Method: ${batches} batches x ${sessions} fresh sessions/mode, synthetic initialization ${initializationMs}ms`,
	);
	const modes: Array<{
		name: "cold-in-process" | "cold-process" | "prewarmed-process";
		harness: ProcessHarness;
		browser: ProcessBrowser;
		samples: Array<Awaited<ReturnType<typeof measureFirstSend>>>;
	}> = [];
	const harnesses: ProcessHarness[] = [];
	const cleanup: Array<{ pid: number; alive: boolean; rootRemoved: boolean }> =
		[];
	let failure: unknown;
	try {
		for (const name of [
			"cold-in-process",
			"cold-process",
			"prewarmed-process",
		] as const) {
			const harness = await ProcessHarness.start({
				dist,
				queryInitializationDelayMs: initializationMs,
				...(name === "cold-in-process"
					? {}
					: { claudeRunner: "process" as const }),
			});
			harnesses.push(harness);
			const mode = {
				name,
				harness,
				browser: await harness.connect(),
				samples: [] as Array<Awaited<ReturnType<typeof measureFirstSend>>>,
			};
			modes.push(mode);
		}
		for (let batch = 0; batch < batches; batch++) {
			for (let round = 0; round < sessions; round++) {
				for (let offset = 0; offset < modes.length; offset++) {
					const mode = modes[(batch + round + offset) % modes.length];
					if (!mode) throw new Error("Missing benchmark mode");
					mode.samples.push(
						await measureFirstSend(
							mode.harness,
							mode.browser,
							mode.name === "prewarmed-process",
							batch,
							round,
						),
					);
				}
			}
			console.log(`Batch ${batch + 1}/${batches} complete`);
		}
	} catch (error) {
		failure = error;
	} finally {
		for (const harness of harnesses) {
			const pids = new Set([
				...harness.generations.map((generation) => generation.pid),
				...harness.marks.flatMap((mark) =>
					mark.kind === "runner-started" ? [mark.pid] : [],
				),
			]);
			try {
				await harness.dispose();
				await waitUntil(
					() => ![...pids].some(alive),
					"benchmark child cleanup",
				);
			} catch (error) {
				failure ??= error;
			}
			const rootRemoved = !existsSync(harness.root);
			cleanup.push(
				...[...pids].map((pid) => ({ pid, alive: alive(pid), rootRemoved })),
			);
		}
	}
	const results = modes.map((mode) => ({
		name: mode.name,
		sendToEnqueue: mode.samples.length
			? summary(mode.samples.map((sample) => sample.sendToEnqueueMs))
			: undefined,
		clientToFirstChunk: mode.samples.length
			? summary(mode.samples.map((sample) => sample.clientToFirstChunkMs))
			: undefined,
		medianBatchP99: mode.samples.length
			? percentile(
					Array.from({ length: batches }, (_, batch) => {
						const samples = mode.samples.filter(
							(sample) => sample.batch === batch,
						);
						return samples.length
							? percentile(
									samples.map((sample) => sample.sendToEnqueueMs),
									0.99,
								)
							: 0;
					}),
					0.5,
				)
			: undefined,
		...(mode.name === "prewarmed-process" && mode.samples.length
			? {
					preWarm: summary(mode.samples.map((sample) => sample.preWarmMs ?? 0)),
					repeatPreWarm: summary(
						mode.samples.map((sample) => sample.repeatPreWarmMs ?? 0),
					),
				}
			: {}),
		samples: mode.samples,
	}));
	const baseline = results.find((result) => result.name === "cold-in-process");
	const warm = results.find((result) => result.name === "prewarmed-process");
	const passed =
		!failure &&
		baseline?.sendToEnqueue !== undefined &&
		warm?.sendToEnqueue !== undefined &&
		baseline.medianBatchP99 !== undefined &&
		warm.medianBatchP99 !== undefined &&
		warm.sendToEnqueue.p50 <= baseline.sendToEnqueue.p50 &&
		warm.sendToEnqueue.p99 <= baseline.sendToEnqueue.p99 &&
		warm.medianBatchP99 <= baseline.medianBatchP99;
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(
		output,
		JSON.stringify(
			{
				machine,
				dist,
				method,
				results,
				gate: { passed },
				cleanup,
				allChildrenTerminated: cleanup.every(
					(child) => !child.alive && child.rootRemoved,
				),
				harnesses: harnesses.map((harness) => harness.proof()),
				...(failure
					? {
							error:
								failure instanceof Error ? failure.message : String(failure),
						}
					: {}),
			},
			null,
			2,
		),
	);
	for (const result of results) {
		if (result.sendToEnqueue)
			console.log(
				`${result.name}: send->enqueue p50=${result.sendToEnqueue.p50.toFixed(3)}ms p99=${result.sendToEnqueue.p99.toFixed(3)}ms median-batch-p99=${result.medianBatchP99?.toFixed(3)}ms`,
			);
	}
	console.log(
		`${passed ? "PASS" : "FAIL"} prewarmed first send <= cold in-process; ${output}`,
	);
	if (failure) throw failure;
	if (!passed)
		throw new Error(
			"Prewarmed first-send latency exceeded the in-process baseline",
		);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
