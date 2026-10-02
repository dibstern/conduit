// Command router and main entry point. The thin entry point (cli.ts) calls
// run() with process.argv. Command handlers and utilities live in sibling modules.

import { getTailscaleIP } from "../lib/cli/tls.js";
import type { WsRpcRequest } from "../lib/contracts/ws-rpc.js";
import {
	type SendRPC,
	sendRpcRequest,
} from "../lib/daemon/daemon-rpc-client.js";
import type { DaemonOptions } from "../lib/daemon/daemon-types.js";
import { isDaemonRunning } from "../lib/daemon/daemon-utils.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../lib/domain/daemon/Layers/daemon-foreground.js";
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
