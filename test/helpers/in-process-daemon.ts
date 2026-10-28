import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type SendRPC,
	sendRpcRequest,
} from "../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import {
	captureExistingChildren,
	stopDaemonAndAssertNoSurvivors,
} from "../e2e/helpers/daemon-survivors.js";

/** Sequential tests only: foreground startup changes process-wide logging. */
export function createInProcessDaemon() {
	const existingChildren = captureExistingChildren();
	// Keep Unix socket paths short, including on macOS.
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ipd-")));
	const configDir = join(root, "config");
	const projectDir = join(root, "process-test");
	const socketPath = join(root, "relay.sock");
	let daemon: ForegroundDaemonHandle | undefined;
	try {
		for (const directory of [configDir, projectDir, join(root, "static")])
			mkdirSync(directory);
		execFileSync("git", ["-C", projectDir, "init", "-b", "main"], {
			stdio: "pipe",
		});
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}

	const rpc: SendRPC = (request) =>
		sendRpcRequest(socketPath, request, { startupRetries: 0 });
	const stop = async () => {
		if (!daemon) return;
		await stopDaemonAndAssertNoSurvivors(async () => {
			await daemon?.stop();
			daemon = undefined;
		}, existingChildren);
	};

	return {
		root,
		configDir,
		projectDir,
		rpc,
		get port() {
			if (!daemon) throw new Error("Daemon is not running");
			return daemon.port;
		},
		stop,
		/** First start or full disposal/reopen, retaining only the fixture files. */
		async restart() {
			await stop();
			daemon = await startForegroundDaemon({
				configDir,
				socketPath,
				port: 0,
				host: "127.0.0.1",
				staticDir: join(root, "static"),
				claudeConfigDir: join(root, "claude"),
				opencodeUrl: "http://127.0.0.1:0",
				smartDefault: false,
				keepAwake: false,
				logLevel: "error",
			});
		},
		async dispose() {
			try {
				await stop();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}
