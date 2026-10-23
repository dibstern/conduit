import { channel } from "node:diagnostics_channel";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { SubprocessDiagnostic } from "../../src/lib/domain/daemon/Services/subprocess.js";

export interface DaemonBudgetMeasurement {
	id: number;
	startedAtMs: number;
	durationMs: number;
	spawns: {
		command: string;
		args: readonly string[];
		cwd: string;
		atMs: number;
	}[];
	loopDelayMs: { samples: number; p50: number; p99: number; max: number };
	subprocess: {
		spawnCount: number;
		active: number;
		queued: number;
		quietForMs: number;
	};
}

/** Runs in the isolated daemon; fixture commands never enter this channel. */
export function recordDaemonBudgetMetrics(directory: string): () => void {
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	let spawns: DaemonBudgetMeasurement["spawns"] = [];
	let startedAt = performance.now();
	let lastActivityAt = startedAt;
	let owner = { spawnCount: 0, active: 0, queued: 0 };
	const metrics = channel("conduit:subprocess-metrics");
	const record = (message: unknown) => {
		const { spawn, spawnCount, active, queued } =
			message as SubprocessDiagnostic;
		owner = { spawnCount, active, queued };
		lastActivityAt = performance.now();
		if (spawn)
			spawns.push({
				...spawn,
				command: basename(spawn.command),
				atMs: performance.now() - startedAt,
			});
	};
	metrics.subscribe(record);
	let previousId = -1;
	const respond = () => {
		const request: { id: number; action: "begin" | "end" | "snapshot" } =
			JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));
		if (request.id === previousId) return;
		previousId = request.id;
		if (request.action === "begin") {
			spawns = [];
			startedAt = performance.now();
			histogram.reset();
		}
		const ms = (ns: number) => Math.round(ns / 1e3) / 1e3;
		writeFileSync(
			join(directory, "response.json"),
			JSON.stringify({
				id: request.id,
				startedAtMs: performance.timeOrigin + startedAt,
				durationMs: performance.now() - startedAt,
				spawns,
				loopDelayMs: {
					samples: histogram.count,
					p50: histogram.count ? ms(histogram.percentile(50)) : 0,
					p99: histogram.count ? ms(histogram.percentile(99)) : 0,
					max: histogram.count ? ms(histogram.max) : 0,
				},
				subprocess: {
					...owner,
					quietForMs: performance.now() - lastActivityAt,
				},
			} satisfies DaemonBudgetMeasurement),
		);
	};
	// Polling avoids coalesced directory watch events losing a phase boundary.
	const timer = setInterval(respond, 50);
	timer.unref();
	respond();
	return () => {
		clearInterval(timer);
		metrics.unsubscribe(record);
		histogram.disable();
	};
}
