// Command router and main entry point. The thin entry point (cli.ts) calls
// run() with process.argv. Command handlers and utilities live in sibling modules.

import { BUILD_ID } from "../lib/build-id.js";
import { getTailscaleIP } from "../lib/cli/tls.js";
import type { WsRpcRequest } from "../lib/contracts/ws-rpc.js";
import {
	type SendRPC,
	sendRpcRequest,
} from "../lib/daemon/daemon-rpc-client.js";
import type { DaemonOptions } from "../lib/daemon/daemon-types.js";
import {
	isDaemonRunning,
	readDaemonBuild,
} from "../lib/daemon/daemon-utils.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../lib/domain/daemon/Layers/daemon-foreground.js";
import { formatErrorDetail } from "../lib/errors.js";
import { isProcessAlive } from "../lib/instance/managed-opencode-process.js";
import { isRecord } from "../lib/utils.js";
import {
	type CommandContext,
	handleAdd,
	handleHelp,
	handleList,
	handlePin,
	handleRemove,
	handleServe,
	handleStatus,
	handleStop,
	handleTitle,
} from "./cli-command-handlers.js";
import { handleDefault } from "./cli-default-command.js";
import { handleDoctor } from "./cli-doctor.js";
import { handleInstance } from "./cli-instance-command.js";
import { handleService } from "./cli-service.js";
import {
	DEFAULT_SOCKET_PATH,
	generateQR,
	getNetworkAddress,
	parseArgs,
} from "./cli-utils.js";

// Re-exports (preserve public API)

export type { ParsedArgs } from "./cli-utils.js";
export {
	generateQR,
	getNetworkAddress,
	parseArgs,
} from "./cli-utils.js";

export interface CLIOptions {
	/** Config directory for server startup and local diagnostics. */
	configDir?: string;
	cwd?: string;
	stdout?: { write(s: string): void };
	stderr?: { write(s: string): void };
	exit?: (code: number) => void;
	sendRPC?: SendRPC;
	isDaemonRunning?: () => Promise<boolean>;
	startForegroundDaemon?: (
		opts: DaemonOptions,
	) => Promise<ForegroundDaemonHandle>;
	generateQR?: (url: string) => string;
	getNetworkAddress?: () => string | null;
	getTailscaleIP?: () => string | null;
}

export async function run(argv: string[], options?: CLIOptions): Promise<void> {
	const args = parseArgs(argv);

	const cwd = options?.cwd ?? args.cwd;
	const stdout = options?.stdout ?? process.stdout;
	const stderr = options?.stderr ?? process.stderr;
	const exit = options?.exit ?? process.exit;
	if (args.skipPerms) {
		stderr.write(
			"Warning: --dangerously-skip-permissions is deprecated and has no effect.\n",
		);
	}

	const rpcSend: SendRPC =
		options?.sendRPC ??
		(<R extends WsRpcRequest>(request: R) =>
			sendRpcRequest(DEFAULT_SOCKET_PATH, request));

	const checkDaemon =
		options?.isDaemonRunning ?? (() => isDaemonRunning(DEFAULT_SOCKET_PATH));

	const startForegroundDaemonFn =
		options?.startForegroundDaemon ?? startForegroundDaemon;

	const qr = options?.generateQR ?? generateQR;
	const getAddr = options?.getNetworkAddress ?? getNetworkAddress;
	const getTsIP = options?.getTailscaleIP ?? getTailscaleIP;

	const context: CommandContext = {
		args,
		options,
		cwd,
		stdout,
		stderr,
		exit,
		rpcSend,
		checkDaemon,
		startForegroundDaemonFn,
		qr,
		getAddr,
		getTsIP,
	};

	// A daemon from another build may speak an RPC wire this CLI cannot decode,
	// so no command sends RPC to a mismatched daemon. The build comes from the
	// plain file beside the socket. On a mismatch, stop sends SIGTERM to the
	// recorded pid and waits for it to exit; every other command, --status
	// included, exits 1. Exempt: serve and doctor (own startup checks), help,
	// and service (install/uninstall replace the daemon). "dev" builds and
	// daemons that predate the file never mismatch.
	const daemonBuild =
		options?.sendRPC === undefined &&
		!["serve", "doctor", "help", "service"].includes(args.command)
			? readDaemonBuild(DEFAULT_SOCKET_PATH)
			: undefined;
	if (
		daemonBuild !== undefined &&
		daemonBuild.buildId !== "dev" &&
		BUILD_ID !== "dev" &&
		daemonBuild.buildId !== BUILD_ID
	) {
		if (args.command === "stop") {
			if (!(await checkDaemon())) return handleStop(context);
			try {
				process.kill(daemonBuild.pid, "SIGTERM");
			} catch (err) {
				if (!isRecord(err) || err["code"] !== "ESRCH") {
					stderr.write(`Failed to stop daemon: ${formatErrorDetail(err)}\n`);
					exit(1);
					return;
				}
			}
			const deadline = Date.now() + 30_000;
			while (isProcessAlive(daemonBuild.pid)) {
				if (Date.now() > deadline) {
					stderr.write(
						`Failed to stop daemon: pid ${daemonBuild.pid} still running after 30s.\n`,
					);
					exit(1);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			stdout.write("Server stopped.\n");
			return;
		}
		stderr.write(
			`Build mismatch: this CLI is build ${BUILD_ID}, the running server is build ${daemonBuild.buildId}.\n`,
		);
		stderr.write(
			"Restart the server: conduit stop, then conduit serve (an installed service restarts by itself).\n",
		);
		exit(1);
		return;
	}

	switch (args.command) {
		case "service":
			return handleService(context);
		case "doctor":
			return handleDoctor({
				stdout,
				...(options?.configDir && { configDir: options.configDir }),
			});
		case "serve":
			return handleServe(context);
		case "help":
			return handleHelp(context);
		case "status":
			return handleStatus(context);
		case "stop":
			return handleStop(context);
		case "pin":
			return handlePin(context);
		case "add":
			return handleAdd(context);
		case "remove":
			return handleRemove(context);
		case "list":
			return handleList(context);
		case "title":
			return handleTitle(context);
		case "instance":
			return handleInstance(context);
		default:
			return handleDefault(context);
	}
}
