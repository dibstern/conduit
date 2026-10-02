// CLI command handlers. Keep command output and failure paths local to each handler.

import { resolve } from "node:path";
import {
	AddProject,
	GetStatus,
	type IpcTaggedRequest,
	ListProjects,
	RemoveProject,
	SetPin,
	SetProjectTitle,
	Shutdown,
} from "../lib/contracts/ipc-requests.js";
import { ENV, RELAY_ENV_KEYS } from "../lib/env.js";
import { formatErrorDetail } from "../lib/errors.js";
import type { IPCResponse } from "../lib/types.js";
import type { CLIOptions } from "./cli-core.js";
import {
	DEFAULT_CONFIG_DIR,
	DEFAULT_PORT,
	formatUptime,
	HELP_TEXT,
	type ParsedArgs,
} from "./cli-utils.js";

export interface CommandContext {
	args: ParsedArgs;
	options: CLIOptions | undefined;
	cwd: string;
	stdout: { write(s: string): void };
	stderr: { write(s: string): void };
	exit: (code: number) => void;
	ipcSend: (cmd: IpcTaggedRequest) => Promise<IPCResponse>;
	checkDaemon: () => Promise<boolean>;
	spawnDaemonFn: NonNullable<CLIOptions["spawnDaemon"]>;
	startForegroundDaemonFn: NonNullable<CLIOptions["startForegroundDaemon"]>;
	startDaemonChildProcessFn: NonNullable<CLIOptions["startDaemonChildProcess"]>;
	qr: NonNullable<CLIOptions["generateQR"]>;
	getAddr: NonNullable<CLIOptions["getNetworkAddress"]>;
	getTsIP: NonNullable<CLIOptions["getTailscaleIP"]>;
}

export async function handleDaemon(ctx: CommandContext): Promise<void> {
	const { args, startDaemonChildProcessFn } = ctx;

	// This is the child process spawned by Daemon.spawn().
	// Read config from env vars set by the parent.
	const daemonPort = Number.parseInt(
		process.env[RELAY_ENV_KEYS.PORT] ?? String(DEFAULT_PORT),
		10,
	);
	const daemonHost = process.env[RELAY_ENV_KEYS.HOST];
	const daemonConfigDir =
		process.env[RELAY_ENV_KEYS.CONFIG_DIR] ?? DEFAULT_CONFIG_DIR;

	const pinHash = process.env[RELAY_ENV_KEYS.PIN_HASH];
	const opencodeUrl = process.env[RELAY_ENV_KEYS.OC_URL];
	const keepAwakeCommand = process.env[RELAY_ENV_KEYS.KEEP_AWAKE_COMMAND];
	const keepAwakeArgsRaw = process.env[RELAY_ENV_KEYS.KEEP_AWAKE_ARGS];
	const claudeConfigDir = process.env[RELAY_ENV_KEYS.CLAUDE_CONFIG_DIR];
	await startDaemonChildProcessFn({
		port: daemonPort,
		...(daemonHost ? { host: daemonHost } : {}),
		configDir: daemonConfigDir,
		...(pinHash ? { pinHash } : {}),
		keepAwake: process.env[RELAY_ENV_KEYS.KEEP_AWAKE] === "1",
		...(keepAwakeCommand ? { keepAwakeCommand } : {}),
		...(keepAwakeArgsRaw
			? { keepAwakeArgs: JSON.parse(keepAwakeArgsRaw) as string[] }
			: {}),
		tlsEnabled: process.env[RELAY_ENV_KEYS.TLS] === "1",
		...(claudeConfigDir ? { claudeConfigDir } : {}),
		...(opencodeUrl ? { opencodeUrl } : {}),
		logLevel: args.logLevel,
		logFormat: args.logFormat ?? "json",
	});
	// Resolves only after shutdown (signal or IPC), then exits the process.
	return;
}

export async function handleForeground(ctx: CommandContext): Promise<void> {
	const {
		args,
		cwd,
		stdout,
		exit,
		checkDaemon,
		ipcSend,
		startForegroundDaemonFn,
	} = ctx;

	// Stop any running daemon first if requested (avoids port conflicts)
	if (args.restartDaemon) {
		try {
			const running = await checkDaemon();
			if (running) {
				await ipcSend(new Shutdown({}));
				stdout.write("Stopped existing daemon.\n");
			}
		} catch {
			// Daemon not running or already stopped — continue
		}
	}

	const opencodeUrl = ENV.opencodeUrl || `http://localhost:${args.ocPort}`;

	stdout.write(`\nConduit (foreground)\n`);
	stdout.write(`  OpenCode: ${opencodeUrl}\n`);

	const daemon = await startForegroundDaemonFn({
		port: args.port,
		...(args.host ? { host: args.host } : {}),
		...(args.claudeConfigDir ? { claudeConfigDir: args.claudeConfigDir } : {}),
		opencodeUrl,
		// Always enable TLS in foreground (matches daemon spawn behavior).
		// Gracefully falls back to HTTP if mkcert is not available.
		tlsEnabled: !args.noHttps,
		logLevel: args.logLevel,
		logFormat: args.logFormat ?? "pretty",
	});

	await daemon.addProject(cwd);

	const fgStatus = daemon.getStatus();
	const fgScheme = fgStatus.tlsEnabled ? "https" : "http";
	const fgHost = fgStatus.host ?? "localhost";
	stdout.write(`  Relay:    ${fgScheme}://${fgHost}:${daemon.port}\n`);
	stdout.write(`  Project:  ${cwd}\n`);
	stdout.write(`  Ready.\n\n`);
	void daemon.stopped.then(
		() => exit(0),
		() => exit(1),
	);
	return;
}

export async function handleHelp(ctx: CommandContext): Promise<void> {
	const { stdout } = ctx;

	stdout.write(HELP_TEXT);
	return;
}

export async function handleStatus(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	const response = await ipcSend(new GetStatus({}));
	if (!response.ok) {
		stderr.write(
			`Failed to get status: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
		return;
	}

	const uptime = typeof response.uptime === "number" ? response.uptime : 0;
	const port = typeof response.port === "number" ? response.port : DEFAULT_PORT;
	const projectCount =
		typeof response.projectCount === "number" ? response.projectCount : 0;
	const clientCount =
		typeof response.clientCount === "number" ? response.clientCount : 0;

	stdout.write(`Daemon Status\n`);
	stdout.write(`  Uptime:   ${formatUptime(uptime)}\n`);
	stdout.write(`  Port:     ${port}\n`);
	stdout.write(`  Projects: ${projectCount}\n`);
	stdout.write(`  Clients:  ${clientCount}\n`);
	return;
}

export async function handleStop(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		exit(1);
		return;
	}

	try {
		await ipcSend(new Shutdown({}));
		stdout.write("Daemon stopped.\n");
	} catch (err) {
		stderr.write(`Failed to stop daemon: ${formatErrorDetail(err)}\n`);
		exit(1);
	}
	return;
}

export async function handlePin(ctx: CommandContext): Promise<void> {
	const { args, stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	if (!args.pin || !/^\d{4,8}$/.test(args.pin)) {
		stderr.write("PIN must be 4-8 digits.\n");
		exit(1);
		return;
	}

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	const response = await ipcSend(new SetPin({ pin: args.pin }));
	if (response.ok) {
		stdout.write("PIN updated.\n");
	} else {
		stderr.write(`Failed to set PIN: ${response.error ?? "unknown error"}\n`);
		exit(1);
	}
	return;
}

export async function handleAdd(ctx: CommandContext): Promise<void> {
	const { args, cwd, stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	const addDir = resolve(args.addPath ?? cwd);

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	const response = await ipcSend(new AddProject({ directory: addDir }));
	if (response.ok) {
		stdout.write(`Project added: ${response.slug ?? addDir}\n`);
	} else {
		stderr.write(
			`Failed to add project: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
	}
	return;
}

export async function handleRemove(ctx: CommandContext): Promise<void> {
	const { cwd, stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	// First, list projects to find the slug for cwd
	const listResponse = await ipcSend(new ListProjects({}));
	if (!listResponse.ok || !Array.isArray(listResponse.projects)) {
		stderr.write("Failed to list projects.\n");
		exit(1);
		return;
	}

	const projects = listResponse.projects as Array<{
		slug: string;
		directory: string;
	}>;
	const match = projects.find((p) => p.directory === cwd);

	if (!match) {
		stderr.write(`Current directory is not registered: ${cwd}\n`);
		exit(1);
		return;
	}

	const response = await ipcSend(new RemoveProject({ slug: match.slug }));
	if (response.ok) {
		stdout.write(`Project removed: ${match.slug}\n`);
	} else {
		stderr.write(
			`Failed to remove project: ${response.error ?? "unknown error"}\n`,
		);
		exit(1);
	}
	return;
}

export async function handleList(ctx: CommandContext): Promise<void> {
	const { stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	const response = await ipcSend(new ListProjects({}));
	if (!response.ok || !Array.isArray(response.projects)) {
		stderr.write("Failed to list projects.\n");
		exit(1);
		return;
	}

	const projects = response.projects as Array<{
		slug: string;
		directory: string;
		title?: string;
	}>;

	if (projects.length === 0) {
		stdout.write("No projects registered.\n");
		return;
	}

	stdout.write(`Projects (${projects.length}):\n`);
	for (const p of projects) {
		const label = p.title ? `${p.slug} (${p.title})` : p.slug;
		stdout.write(`  ${label}\n    ${p.directory}\n`);
	}
	return;
}

export async function handleTitle(ctx: CommandContext): Promise<void> {
	const { args, cwd, stdout, stderr, exit, checkDaemon, ipcSend } = ctx;

	if (!args.title) {
		stderr.write("Title is required. Usage: --title <name>\n");
		exit(1);
		return;
	}

	const running = await checkDaemon();
	if (!running) {
		stderr.write("Daemon is not running.\n");
		stderr.write("Start with: npx conduit\n");
		exit(1);
		return;
	}

	// Find slug for cwd
	const listResponse = await ipcSend(new ListProjects({}));
	if (!listResponse.ok || !Array.isArray(listResponse.projects)) {
		stderr.write("Failed to list projects.\n");
		exit(1);
		return;
	}

	const projects = listResponse.projects as Array<{
		slug: string;
		directory: string;
	}>;
	const match = projects.find((p) => p.directory === cwd);

	if (!match) {
		stderr.write(`Current directory is not registered: ${cwd}\n`);
		exit(1);
		return;
	}

	const response = await ipcSend(
		new SetProjectTitle({
			slug: match.slug,
			title: args.title,
		}),
	);

	if (response.ok) {
		stdout.write(`Title updated: ${args.title}\n`);
	} else {
		stderr.write(`Failed to set title: ${response.error ?? "unknown error"}\n`);
		exit(1);
	}
	return;
}
