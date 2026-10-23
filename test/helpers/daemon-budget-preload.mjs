// Temporary process-level instrumentation for conduit-test-g43i.1. Replace
// this collector with the subprocess owner's metrics when that seam lands.
import childProcess from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { isMainThread } from "node:worker_threads";

// NODE_OPTIONS is inherited by runners. Only instrument the daemon itself.
const root = new URL(import.meta.url).searchParams.get("directory");
if (
	root &&
	isMainThread &&
	/(?:process-harness-server|cli)\.(?:ts|js)$/.test(process.argv[1] ?? "")
) {
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	let spawns = [];
	let startedAt = performance.now();
	const record = (command, args, options) => {
		spawns.push({
			command: basename(String(command)),
			args: Array.from(args ?? [], String),
			cwd: String(options?.cwd ?? process.cwd()),
			atMs: performance.now() - startedAt,
		});
	};
	// This catches spawn, execFile, exec and fork without double counting.
	const spawn = childProcess.ChildProcess.prototype.spawn;
	childProcess.ChildProcess.prototype.spawn = function (options) {
		record(options.file, options.args.slice(1), options);
		return spawn.call(this, options);
	};
	// Synchronous entrypoints do not use ChildProcess.prototype.spawn.
	for (const name of ["spawnSync", "execFileSync", "execSync"]) {
		const original = childProcess[name];
		childProcess[name] = function (command, ...rest) {
			const args = Array.isArray(rest[0]) ? rest[0] : [];
			const options = Array.isArray(rest[0]) ? rest[1] : rest[0];
			record(command, args, options);
			return original.call(this, command, ...rest);
		};
	}
	syncBuiltinESMExports();

	let previousId = -1;
	const respond = () => {
		const request = JSON.parse(
			readFileSync(join(root, "request.json"), "utf8"),
		);
		if (request.id === previousId) return;
		previousId = request.id;
		if (request.action === "begin") {
			spawns = [];
			startedAt = performance.now();
			histogram.reset();
		}
		const ms = (ns) => Math.round(ns / 1e3) / 1e3;
		writeFileSync(
			join(root, "response.json"),
			JSON.stringify({
				id: request.id,
				durationMs: performance.now() - startedAt,
				spawns,
				loopDelayMs: {
					samples: histogram.count,
					p50: histogram.count ? ms(histogram.percentile(50)) : 0,
					p99: histogram.count ? ms(histogram.percentile(99)) : 0,
					max: histogram.count ? ms(histogram.max) : 0,
				},
			}),
		);
	};
	// Directory watch events can coalesce across the request and response
	// renames on macOS. Poll this tiny control file so no phase boundary is lost.
	setInterval(respond, 50).unref();
	respond();
}
