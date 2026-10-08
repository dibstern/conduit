import { subscribe } from "node:diagnostics_channel";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect, Fiber } from "effect";

// Event-loop stalls and read-model reads for load tests, flushed to a file the
// spec reads after each phase. Stalls are wall-clock end times and durations.
function recordServerMetrics(file: string): void {
	const startedAt = Date.now();
	const stalls: { at: number; ms: number }[] = [];
	const reads: Record<string, number> = {};
	const windows = new Set<number>();
	// Per source name: reads by kind, the distinct changes its windows read, and
	// the distinct windows (`after-through`) it read.
	const sources: Record<
		string,
		{ reads: Record<string, number>; windows: Set<number>; ranges: Set<string> }
	> = {};
	const sidebarReads: { at: number; ms: number; rows: number }[] = [];
	subscribe("conduit:sidebar-read", (message) => {
		const read =
			message as import("../../src/lib/domain/relay/Services/shell-subscription.js").SidebarRead;
		sidebarReads.push({ at: Date.now(), ms: read.ms, rows: read.rows });
	});
	subscribe("conduit:read-model-read", (message) => {
		const read =
			message as import("../../src/lib/domain/relay/Services/read-model-subscription.js").ReadModelRead;
		const source = (sources[read.source] ??= {
			reads: {},
			windows: new Set(),
			ranges: new Set(),
		});
		reads[read.kind] = (reads[read.kind] ?? 0) + 1;
		source.reads[read.kind] = (source.reads[read.kind] ?? 0) + 1;
		if (read.kind === "window" && read.range?.through !== undefined) {
			windows.add(read.range.through);
			source.windows.add(read.range.through);
			source.ranges.add(`${read.range.after}-${read.range.through}`);
		}
	});
	const tickMs = 10;
	let last = performance.now();
	setInterval(() => {
		const now = performance.now();
		const ms = Math.round(now - last - tickMs);
		if (ms >= 20) stalls.push({ at: Date.now(), ms });
		last = now;
	}, tickMs).unref();
	// Written beside the file and renamed over it: past one 8 KB write, a spec
	// polling the file would otherwise read it half written.
	setInterval(() => {
		writeFileSync(
			`${file}.tmp`,
			JSON.stringify({
				pid: process.pid,
				startedAt,
				flushedAt: Date.now(),
				stalls,
				reads,
				changesRead: windows.size,
				sources: Object.fromEntries(
					Object.entries(sources).map(([name, source]) => [
						name,
						{
							reads: source.reads,
							changesRead: source.windows.size,
							windowsRead: source.ranges.size,
						},
					]),
				),
				sidebarReads,
			}),
		);
		renameSync(`${file}.tmp`, file);
	}, 250).unref();
}

async function main(): Promise<void> {
	const root = process.argv[2];
	const dist = process.argv[3];
	if (!root || !process.send || process.env["HOME"] !== join(root, "home")) {
		throw new Error(
			"Process harness requires an isolated HOME and IPC channel",
		);
	}
	let daemon:
		| import("../../src/lib/domain/daemon/Layers/daemon-foreground.js").ForegroundDaemonHandle
		| undefined;
	let disconnected = false;
	// The parent cannot enforce its kill deadline after it disappears. Keep a
	// local deadline, including disconnects during daemon startup.
	process.once("disconnect", () => {
		disconnected = true;
		// Allow the runner's 1s reply window and 3s force-kill budget to finish.
		setTimeout(() => process.exit(1), 6000);
		void daemon?.stop().catch((error: unknown) => {
			console.error(error);
			process.exit(1);
		});
	});
	if (!process.connected) process.exit(1);
	const metricsFile = process.env["CONDUIT_TEST_SERVER_METRICS"];
	if (metricsFile) recordServerMetrics(metricsFile);
	const codeRoot = dist
		? join(dist, "src")
		: fileURLToPath(new URL("../../src", import.meta.url));
	const extension = dist ? "js" : "ts";
	if (existsSync(join(root, "capabilities-probe-gated"))) {
		const { ClaudeDriver } = (await import(
			pathToFileURL(
				join(
					codeRoot,
					"lib/provider/claude",
					`claude-provider-instance.${extension}`,
				),
			).href
		)) as typeof import("../../src/lib/provider/claude/claude-provider-instance.js");
		const { makeClaudeCapabilitiesService } = (await import(
			pathToFileURL(
				join(
					codeRoot,
					"lib/provider/claude",
					`claude-capabilities-service.${extension}`,
				),
			).href
		)) as typeof import("../../src/lib/provider/claude/claude-capabilities-service.js");
		const create = ClaudeDriver.create;
		Object.assign(ClaudeDriver, {
			create: (
				deps: import("../../src/lib/provider/claude/claude-provider-instance.js").ClaudeProviderInstanceDeps,
			) =>
				Effect.gen(function* () {
					const service = yield* makeClaudeCapabilitiesService();
					let consumerId = 0;
					return yield* create({
						...deps,
						capabilitiesService: {
							get: (workspaceRoot) =>
								Effect.gen(function* () {
									const id = ++consumerId;
									const request = yield* Effect.fork(
										service.get(workspaceRoot),
									);
									yield* Effect.yieldNow();
									const status = yield* Fiber.status(request);
									writeFileSync(
										join(root, `capabilities-consumer-${id}.json`),
										JSON.stringify({ workspaceRoot, status: status._tag }),
									);
									return yield* Fiber.join(request);
								}),
						},
					});
				}),
		});
	}
	const { __setProbeOverrideForTesting } = (await import(
		pathToFileURL(
			join(
				codeRoot,
				"lib/provider/claude",
				`claude-capabilities-probe.${extension}`,
			),
		).href
	)) as typeof import("../../src/lib/provider/claude/claude-capabilities-probe.js");
	let probeAttempts = 0;
	__setProbeOverrideForTesting(async (workspaceRoot) => {
		if (existsSync(join(root, "capabilities-probe-gated"))) {
			writeFileSync(join(root, "capabilities-probe-started"), workspaceRoot);
			writeFileSync(
				join(root, "capabilities-probe-attempts.json"),
				JSON.stringify({ count: ++probeAttempts, workspaceRoot }),
			);
			while (!existsSync(join(root, "capabilities-probe-release")))
				await new Promise<void>((done) => setTimeout(done, 10));
		}
		const resultPath = join(root, "capabilities-probe-result.json");
		return existsSync(resultPath)
			? (JSON.parse(
					readFileSync(resultPath, "utf8"),
				) as import("../../src/lib/provider/claude/claude-capabilities-probe.js").ProbeResult)
			: { models: [], agents: [], commands: [] };
	});
	const { startForegroundDaemon } = (await import(
		pathToFileURL(
			join(
				codeRoot,
				"lib/domain/daemon/Layers",
				`daemon-foreground.${extension}`,
			),
		).href
	)) as typeof import("../../src/lib/domain/daemon/Layers/daemon-foreground.js");
	const activeDaemon = await startForegroundDaemon({
		port: Number(process.env["CONDUIT_TEST_PORT"] ?? 0),
		host: "127.0.0.1",
		configDir:
			process.env["CONDUIT_TEST_DAEMON_CONFIG_DIR"] ?? join(root, "config"),
		claudeConfigDir: process.env["CLAUDE_CONFIG_DIR"] ?? join(root, "claude"),
		staticDir: dist ? join(dist, "frontend") : join(root, "static"),
		smartDefault: false,
		// An unreachable unmanaged placeholder also keeps the relay's legacy
		// OpenCode pollers away from a developer's localhost:4096 instance.
		opencodeUrl:
			process.env["CONDUIT_TEST_OPENCODE_URL"] ?? "http://127.0.0.1:0",
		keepAwake: false,
		logLevel: "error",
	});
	daemon = activeDaemon;
	if (disconnected) {
		await activeDaemon.stop();
		process.exit(0);
	}
	await activeDaemon.addProject(join(root, "process-test"));
	process.send({
		channel: "conduit-process-test",
		kind: "ready",
		port: activeDaemon.port,
		pid: process.pid,
		projects: activeDaemon.getProjects().map((project) => project.folders[0]),
		instances: activeDaemon
			.getInstances()
			.map((instance) => ({ managed: instance.managed, url: instance.url })),
	});
	await activeDaemon.stopped;
	// Runtime disposal leaves timers alive; match the real daemon child entry.
	process.exit(0);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
