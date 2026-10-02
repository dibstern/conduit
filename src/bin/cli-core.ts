// Command router and main entry point. The thin entry point (cli.ts) calls
// run() with process.argv. Command handlers and utilities live in sibling modules.

import { getTailscaleIP } from "../lib/cli/tls.js";
import type { IpcTaggedRequest } from "../lib/contracts/ipc-requests.js";
import { spawnDaemon } from "../lib/daemon/daemon-spawn.js";
import type { DaemonOptions } from "../lib/daemon/daemon-types.js";
import { isDaemonRunning } from "../lib/daemon/daemon-utils.js";
import {
	type ForegroundDaemonHandle,
	startDaemonChildProcess,
	startForegroundDaemon,
} from "../lib/domain/daemon/Layers/daemon-foreground.js";
import type { IPCResponse } from "../lib/types.js";
import {
	type CommandContext,
	handleAdd,
	handleDaemon,
	handleForeground,
	handleHelp,
	handleList,
	handlePin,
	handleRemove,
	handleStatus,
	handleStop,
	handleTitle,
} from "./cli-command-handlers.js";
import { handleDefault } from "./cli-default-command.js";
import { handleInstance } from "./cli-instance-command.js";
import { handleService } from "./cli-service.js";
import {
	DEFAULT_SOCKET_PATH,
	generateQR,
	getNetworkAddress,
	parseArgs,
	sendIpcRequest,
} from "./cli-utils.js";

// Re-exports (preserve public API)

export type { ParsedArgs } from "./cli-utils.js";
export {
	generateQR,
	getNetworkAddress,
	parseArgs,
	sendIpcRequest,
} from "./cli-utils.js";

export interface CLIOptions {
	cwd?: string;
	stdin?: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
	stdout?: { write(s: string): void };
	stderr?: { write(s: string): void };
	exit?: (code: number) => void;
	sendIPC?: (cmd: IpcTaggedRequest) => Promise<IPCResponse>;
	isDaemonRunning?: () => Promise<boolean>;
	spawnDaemon?: (
		opts?: DaemonOptions,
	) => Promise<{ pid: number; port: number }>;
	startForegroundDaemon?: (
		opts: DaemonOptions,
	) => Promise<ForegroundDaemonHandle>;
	startDaemonChildProcess?: (opts: DaemonOptions) => Promise<void>;
	generateQR?: (url: string) => string;
	getNetworkAddress?: () => string | null;
	getTailscaleIP?: () => string | null;
	/** Injectable for testing: override the interactive menu (setup + main menu). */
	showInteractiveMenu?: (ctx: InteractiveContext) => Promise<void>;
}

/** Context passed to the interactive menu flow. */
export interface InteractiveContext {
	args: import("./cli-utils.js").ParsedArgs;
	cwd: string;
	stdin: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
	stdout: { write(s: string): void };
	stderr: { write(s: string): void };
	exit: (code: number) => void;
	ipcSend: (cmd: IpcTaggedRequest) => Promise<IPCResponse>;
	checkDaemon: () => Promise<boolean>;
	spawnDaemon: (opts?: DaemonOptions) => Promise<{ pid: number; port: number }>;
	getAddr: () => string | null;
	generateQR: (url: string) => string;
}

export async function run(argv: string[], options?: CLIOptions): Promise<void> {
	const args = parseArgs(argv);

	const cwd = options?.cwd ?? args.cwd;
	const stdout = options?.stdout ?? process.stdout;
	const stderr = options?.stderr ?? process.stderr;
	const exit = options?.exit ?? process.exit;

	const ipcSend =
		options?.sendIPC ??
		((request: IpcTaggedRequest) =>
			sendIpcRequest(DEFAULT_SOCKET_PATH, request));

	const checkDaemon =
		options?.isDaemonRunning ?? (() => isDaemonRunning(DEFAULT_SOCKET_PATH));

	const spawnDaemonFn =
		options?.spawnDaemon ??
		((opts?: DaemonOptions) =>
			spawnDaemon(
				{
					port: args.port,
					...(args.host ? { host: args.host } : {}),
					...(args.claudeConfigDir
						? { claudeConfigDir: args.claudeConfigDir }
						: {}),
					...opts,
				},
				isDaemonRunning,
			));
	const startForegroundDaemonFn =
		options?.startForegroundDaemon ?? startForegroundDaemon;
	const startDaemonChildProcessFn =
		options?.startDaemonChildProcess ?? startDaemonChildProcess;

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
		ipcSend,
		checkDaemon,
		spawnDaemonFn,
		startForegroundDaemonFn,
		startDaemonChildProcessFn,
		qr,
		getAddr,
		getTsIP,
	};

	switch (args.command) {
		case "service":
			return handleService(context);
		case "daemon":
			return handleDaemon(context);
		case "foreground":
			return handleForeground(context);
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
