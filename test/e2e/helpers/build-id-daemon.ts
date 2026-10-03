// Compiled by tsgo so the test exercises the stamped server, not source/dev.
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
process.send?.({ port: daemon.port, buildId: BUILD_ID });
const stop = async () => {
	await daemon.stop();
	process.exit(0);
};
process.on("message", (message) => {
	if (message === "stop") void stop();
});
process.on("disconnect", () => void stop());
