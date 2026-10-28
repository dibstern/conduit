// Compiled by tsgo so the test exercises the stamped server, not source/dev.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BUILD_ID } from "../../../src/lib/build-id.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";

const [root, staticDir, opencodeUrl, port] = process.argv.slice(2);
if (!root || !staticDir || !opencodeUrl) throw new Error("Missing test paths");
const configDir = join(root, "config");
__setProbeOverrideForTesting(async () => ({
	models: [],
	commands: [],
	agents: [],
}));
saveRelaySettings({ defaultModel: "opencode/big-pickle" }, configDir);
// The user has already answered the avatar question, so the first-run
// dialog stays shut over the specs that are not about it. A restart keeps
// whatever the first start saved.
if (!existsSync(join(configDir, "daemon.json")))
	writeFileSync(
		join(configDir, "daemon.json"),
		JSON.stringify({
			pid: 0,
			port: 0,
			pinHash: null,
			tls: false,
			debug: false,
			keepAwake: false,
			projects: [],
			avatar: { kind: "initial" },
		}),
	);
const daemon = await startForegroundDaemon({
	port: Number(port ?? 0),
	host: "127.0.0.1",
	configDir,
	socketPath: join(configDir, "relay.sock"),
	staticDir,
	opencodeUrl,
	smartDefault: false,
	logLevel: "error",
});
await daemon.addProject(join(root, "build-id-test"));
await daemon.addProject(join(root, "build-id-other"));
process.send?.({ port: daemon.port, buildId: BUILD_ID });
const stop = async () => {
	await daemon.stop();
	const snapshot = spawnSync("ps", ["-A", "-o", "pid=,ppid=,stat=,command="], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (snapshot.error) throw snapshot.error;
	if (snapshot.status !== 0) throw new Error(`ps failed: ${snapshot.stderr}`);
	const processes = snapshot.stdout.split("\n").flatMap((line) => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
		return match
			? [
					{
						pid: Number(match[1]),
						ppid: Number(match[2]),
						stat: match[3],
						command: match[4],
					},
				]
			: [];
	});
	const descendants = new Set([process.pid]);
	for (const pid of descendants) {
		for (const child of processes) {
			if (child.ppid === pid && child.pid !== snapshot.pid)
				descendants.add(child.pid);
		}
	}
	const survivors = processes.filter(
		(child) =>
			child.pid !== process.pid &&
			descendants.has(child.pid) &&
			!child.stat?.startsWith("Z"),
	);
	if (survivors.length > 0) {
		writeSync(
			2,
			`Children survived daemon.stop():\n${survivors.map((child) => `${child.pid} ${child.command}`).join("\n")}\n`,
		);
		process.exit(1);
	}
	process.exit(0);
};
process.on("message", (message) => {
	if (message === "stop") void stop();
});
process.on("disconnect", () => void stop());
