import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
		setTimeout(() => process.exit(1), 3000);
		void daemon?.stop().catch((error: unknown) => {
			console.error(error);
			process.exit(1);
		});
	});
	if (!process.connected) process.exit(1);
	const codeRoot = dist
		? join(dist, "src")
		: fileURLToPath(new URL("../../src", import.meta.url));
	const extension = dist ? "js" : "ts";
	const { __setProbeOverrideForTesting } = (await import(
		pathToFileURL(
			join(
				codeRoot,
				"lib/provider/claude",
				`claude-capabilities-probe.${extension}`,
			),
		).href
	)) as typeof import("../../src/lib/provider/claude/claude-capabilities-probe.js");
	__setProbeOverrideForTesting(async () => ({
		models: [],
		agents: [],
		commands: [],
	}));
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
		port: 0,
		host: "127.0.0.1",
		configDir:
			process.env["CONDUIT_TEST_DAEMON_CONFIG_DIR"] ?? join(root, "config"),
		claudeConfigDir: join(root, "claude"),
		staticDir: dist ? join(dist, "frontend") : join(root, "static"),
		smartDefault: false,
		// An unreachable unmanaged placeholder also keeps the relay's legacy
		// OpenCode pollers away from a developer's localhost:4096 instance.
		opencodeUrl: "http://127.0.0.1:0",
		keepAwake: false,
		logLevel: "error",
	});
	daemon = activeDaemon;
	if (disconnected) {
		await activeDaemon.stop();
		process.exit(0);
	}
	await activeDaemon.addProject(join(root, "project"), "process-test");
	process.send({
		channel: "conduit-process-test",
		kind: "ready",
		port: activeDaemon.port,
		pid: process.pid,
		projects: activeDaemon.getProjects().map((project) => project.directory),
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
