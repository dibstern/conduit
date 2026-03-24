// ─── CLI Core (Ticket 3.3) ──────────────────────────────────────────────────
// Command router and main entry point. The thin entry point (cli.ts) calls
// run() with process.argv. Individual commands and utilities live in
// cli-commands.ts and cli-utils.ts respectively.

import { resolve } from "node:path";
import { getTailscaleIP } from "../lib/cli/tls.js";
import { Daemon, type DaemonOptions } from "../lib/daemon/daemon.js";
import { ENV, RELAY_ENV_KEYS } from "../lib/env.js";
import { formatErrorDetail } from "../lib/errors.js";
import type { IPCCommand, IPCResponse } from "../lib/types.js";
import { defaultInteractiveMenu } from "./cli-commands.js";
import {
	DEFAULT_CONFIG_DIR,
	DEFAULT_PORT,
	DEFAULT_SOCKET_PATH,
	formatUptime,
	generateQR,
	getNetworkAddress,
	HELP_TEXT,
	parseArgs,
	sendIPCCommand,
} from "./cli-utils.js";

// ─── Re-exports (preserve public API) ──────────────────────────────────────

export type { ParsedArgs } from "./cli-utils.js";
export {
	generateQR,
	getNetworkAddress,
	parseArgs,
	sendIPCCommand,
} from "./cli-utils.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CLIOptions {
	cwd?: string;
	stdin?: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
	stdout?: { write(s: string): void };
	stderr?: { write(s: string): void };
	exit?: (code: number) => void;
	sendIPC?: (cmd: IPCCommand) => Promise<IPCResponse>;
	isDaemonRunning?: () => Promise<boolean>;
	spawnDaemon?: (
		opts?: DaemonOptions,
	) => Promise<{ pid: number; port: number }>;
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
	ipcSend: (cmd: IPCCommand) => Promise<IPCResponse>;
	checkDaemon: () => Promise<boolean>;
	spawnDaemon: (opts?: DaemonOptions) => Promise<{ pid: number; port: number }>;
	getAddr: () => string | null;
	generateQR: (url: string) => string;
}

// ─── Main Run ───────────────────────────────────────────────────────────────

export async function run(argv: string[], options?: CLIOptions): Promise<void> {
	const args = parseArgs(argv);

	const cwd = options?.cwd ?? args.cwd;
	const stdout = options?.stdout ?? process.stdout;
	const stderr = options?.stderr ?? process.stderr;
	const exit = options?.exit ?? process.exit;

	const ipcSend =
		options?.sendIPC ??
		((cmd: IPCCommand) => sendIPCCommand(DEFAULT_SOCKET_PATH, cmd));

	const checkDaemon =
		options?.isDaemonRunning ?? (() => Daemon.isRunning(DEFAULT_SOCKET_PATH));

	const spawnDaemon =
		options?.spawnDaemon ??
		((opts?: DaemonOptions) =>
			Daemon.spawn({
				port: args.port,
				...(args.host ? { host: args.host } : {}),
				...opts,
			}));

	const qr = options?.generateQR ?? generateQR;
	const getAddr = options?.getNetworkAddress ?? getNetworkAddress;
	const getTsIP = options?.getTailscaleIP ?? getTailscaleIP;

	// ─── --daemon (internal: run as background daemon server) ──────────
	if (args.command === "daemon") {
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
		const daemon = new Daemon({
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
			...(opencodeUrl ? { opencodeUrl } : {}),
			logLevel: args.logLevel,
			logFormat: args.logFormat ?? "json",
		});

		await daemon.start();
		// Daemon keeps the process alive via its HTTP + IPC servers.
		// Signal handlers installed by daemon.start() will call daemon.stop().
		return;
	}

	// ─── --foreground (dev mode: run daemon in current process) ──────
	if (args.command === "foreground") {
		// Stop any running daemon first if requested (avoids port conflicts)
		if (args.restartDaemon) {
			try {
				const running = await checkDaemon();
				if (running) {
					await ipcSend({ cmd: "shutdown" });
					stdout.write("Stopped existing daemon.\n");
				}
			} catch {
				// Daemon not running or already stopped — continue
			}
		}

		const opencodeUrl = ENV.opencodeUrl || `http://localhost:${args.ocPort}`;

		stdout.write(`\nConduit (foreground)\n`);
		stdout.write(`  OpenCode: ${opencodeUrl}\n`);

		const daemon = new Daemon({
			port: args.port,
			...(args.host ? { host: args.host } : {}),
			opencodeUrl,
			// Always enable TLS in foreground (matches daemon spawn behavior).
			// Gracefully falls back to HTTP if mkcert is not available.
			tlsEnabled: !args.noHttps,
			logLevel: args.logLevel,
			logFormat: args.logFormat ?? "pretty",
		});

		await daemon.start();
		await daemon.addProject(cwd);

		// Discover projects from OpenCode's project registry
		await daemon.discoverProjects();

		const fgStatus = daemon.getStatus();
		const fgScheme = fgStatus.tlsEnabled ? "https" : "http";
		const fgHost = fgStatus.host ?? "localhost";
		stdout.write(`  Relay:    ${fgScheme}://${fgHost}:${daemon.port}\n`);
		stdout.write(`  Project:  ${cwd}\n`);
		stdout.write(`  Ready.\n\n`);
		return;
	}

	// ─── --help ─────────────────────────────────────────────────────────
	if (args.command === "help") {
		stdout.write(HELP_TEXT);
		return;
	}

	// ─── --status ───────────────────────────────────────────────────────
	if (args.command === "status") {
		const running = await checkDaemon();
		if (!running) {
			stderr.write("Daemon is not running.\n");
			stderr.write("Start with: npx conduit\n");
			exit(1);
			return;
		}

		const response = await ipcSend({ cmd: "get_status" });
		if (!response.ok) {
			stderr.write(
				`Failed to get status: ${response.error ?? "unknown error"}\n`,
			);
			exit(1);
			return;
		}

		const uptime = typeof response.uptime === "number" ? response.uptime : 0;
		const port =
			typeof response.port === "number" ? response.port : DEFAULT_PORT;
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

	// ─── --stop ─────────────────────────────────────────────────────────
	if (args.command === "stop") {
		const running = await checkDaemon();
		if (!running) {
			stderr.write("Daemon is not running.\n");
			exit(1);
			return;
		}

		try {
			await ipcSend({ cmd: "shutdown" });
			stdout.write("Daemon stopped.\n");
		} catch (err) {
			stderr.write(`Failed to stop daemon: ${formatErrorDetail(err)}\n`);
			exit(1);
		}
		return;
	}

	// ─── --pin ──────────────────────────────────────────────────────────
	if (args.command === "pin") {
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

		const response = await ipcSend({ cmd: "set_pin", pin: args.pin });
		if (response.ok) {
			stdout.write("PIN updated.\n");
		} else {
			stderr.write(`Failed to set PIN: ${response.error ?? "unknown error"}\n`);
			exit(1);
		}
		return;
	}

	// ─── --add ──────────────────────────────────────────────────────────
	if (args.command === "add") {
		const addDir = resolve(args.addPath ?? cwd);

		const running = await checkDaemon();
		if (!running) {
			stderr.write("Daemon is not running.\n");
			stderr.write("Start with: npx conduit\n");
			exit(1);
			return;
		}

		const response = await ipcSend({ cmd: "add_project", directory: addDir });
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

	// ─── --remove ───────────────────────────────────────────────────────
	if (args.command === "remove") {
		const running = await checkDaemon();
		if (!running) {
			stderr.write("Daemon is not running.\n");
			stderr.write("Start with: npx conduit\n");
			exit(1);
			return;
		}

		// First, list projects to find the slug for cwd
		const listResponse = await ipcSend({ cmd: "list_projects" });
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

		const response = await ipcSend({ cmd: "remove_project", slug: match.slug });
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

	// ─── --list ─────────────────────────────────────────────────────────
	if (args.command === "list") {
		const running = await checkDaemon();
		if (!running) {
			stderr.write("Daemon is not running.\n");
			stderr.write("Start with: npx conduit\n");
			exit(1);
			return;
		}

		const response = await ipcSend({ cmd: "list_projects" });
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

	// ─── --title ────────────────────────────────────────────────────────
	if (args.command === "title") {
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
		const listResponse = await ipcSend({ cmd: "list_projects" });
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

		const response = await ipcSend({
			cmd: "set_project_title",
			slug: match.slug,
			title: args.title,
		});

		if (response.ok) {
			stdout.write(`Title updated: ${args.title}\n`);
		} else {
			stderr.write(
				`Failed to set title: ${response.error ?? "unknown error"}\n`,
			);
			exit(1);
		}
		return;
	}

	// ─── --instance <action> [name] ────────────────────────────────────
	if (args.command === "instance") {
		const running = await checkDaemon();
		if (!running) {
			stderr.write("Daemon is not running.\n");
			stderr.write("Start with: npx conduit\n");
			exit(1);
			return;
		}

		switch (args.instanceAction) {
			case "list": {
				const response = await ipcSend({ cmd: "instance_list" });
				if (!response.ok) {
					stderr.write(
						`Failed to list instances: ${response.error ?? "unknown error"}\n`,
					);
					exit(1);
					return;
				}
				const instances = (response.instances ?? []) as Array<{
					id: string;
					name: string;
					port: number;
					managed: boolean;
					status: string;
				}>;
				if (instances.length === 0) {
					stdout.write("No instances configured.\n");
					return;
				}
				stdout.write(`Instances (${instances.length}):\n`);
				for (const inst of instances) {
					stdout.write(
						`  ${inst.name} (${inst.id})  port=${inst.port}  managed=${inst.managed}  status=${inst.status}\n`,
					);
				}
				return;
			}

			case "add": {
				if (!args.instanceName) {
					stderr.write(
						"Instance name is required. Usage: --instance add <name>\n",
					);
					exit(1);
					return;
				}
				const response = await ipcSend({
					cmd: "instance_add",
					name: args.instanceName,
					managed: args.instanceManaged ?? false,
					...(args.instancePort != null && { port: args.instancePort }),
					...(args.instanceUrl != null && { url: args.instanceUrl }),
				});
				if (response.ok) {
					stdout.write(
						`Instance added: ${(response.instance as { id: string })?.id ?? args.instanceName}\n`,
					);
				} else {
					stderr.write(
						`Failed to add instance: ${response.error ?? "unknown error"}\n`,
					);
					exit(1);
				}
				return;
			}

			case "remove": {
				if (!args.instanceName) {
					stderr.write(
						"Instance id is required. Usage: --instance remove <id>\n",
					);
					exit(1);
					return;
				}
				const response = await ipcSend({
					cmd: "instance_remove",
					id: args.instanceName,
				});
				if (response.ok) {
					stdout.write(`Instance removed: ${args.instanceName}\n`);
				} else {
					stderr.write(
						`Failed to remove instance: ${response.error ?? "unknown error"}\n`,
					);
					exit(1);
				}
				return;
			}

			case "start": {
				if (!args.instanceName) {
					stderr.write(
						"Instance id is required. Usage: --instance start <id>\n",
					);
					exit(1);
					return;
				}
				const response = await ipcSend({
					cmd: "instance_start",
					id: args.instanceName,
				});
				if (response.ok) {
					stdout.write(`Instance started: ${args.instanceName}\n`);
				} else {
					stderr.write(
						`Failed to start instance: ${response.error ?? "unknown error"}\n`,
					);
					exit(1);
				}
				return;
			}

			case "stop": {
				if (!args.instanceName) {
					stderr.write(
						"Instance id is required. Usage: --instance stop <id>\n",
					);
					exit(1);
					return;
				}
				const response = await ipcSend({
					cmd: "instance_stop",
					id: args.instanceName,
				});
				if (response.ok) {
					stdout.write(`Instance stopped: ${args.instanceName}\n`);
				} else {
					stderr.write(
						`Failed to stop instance: ${response.error ?? "unknown error"}\n`,
					);
					exit(1);
				}
				return;
			}

			case "status": {
				if (!args.instanceName) {
					stderr.write(
						"Instance id is required. Usage: --instance status <id>\n",
					);
					exit(1);
					return;
				}
				const response = await ipcSend({
					cmd: "instance_status",
					id: args.instanceName,
				});
				if (!response.ok) {
					stderr.write(
						`Failed to get instance status: ${response.error ?? "unknown error"}\n`,
					);
					exit(1);
					return;
				}
				const inst = response.instance as {
					id: string;
					name: string;
					port: number;
					managed: boolean;
					status: string;
				};
				stdout.write(`Instance: ${inst.name} (${inst.id})\n`);
				stdout.write(`  Port:    ${inst.port}\n`);
				stdout.write(`  Managed: ${inst.managed}\n`);
				stdout.write(`  Status:  ${inst.status}\n`);
				return;
			}

			default:
				stderr.write(
					"Unknown instance action. Usage: --instance <list|add|remove|start|stop|status>\n",
				);
				exit(1);
				return;
		}
	}

	// ─── Validate --dangerously-skip-permissions ───────────────────────
	if (args.skipPerms && !args.pin) {
		stderr.write("--dangerously-skip-permissions requires --pin\n");
		exit(1);
		return;
	}

	// ─── Default invocation ─────────────────────────────────────────────
	const stdin = options?.stdin ?? process.stdin;

	// Determine if interactive mode should be used:
	// - Explicit injectable overrides everything
	// - stdin being a TTY means real terminal → interactive
	// - Non-TTY (pipe, test, CI) → legacy non-interactive behavior
	if (options?.showInteractiveMenu || (stdin as { isTTY?: boolean }).isTTY) {
		const interactiveMenu =
			options?.showInteractiveMenu ?? defaultInteractiveMenu;

		await interactiveMenu({
			args,
			cwd,
			stdin,
			stdout,
			stderr,
			exit,
			ipcSend,
			checkDaemon,
			spawnDaemon,
			getAddr,
			generateQR: qr,
		});
		return;
	}

	// ─── Non-interactive default (legacy behavior) ──────────────────────
	// 1. Ensure daemon is running
	let running = await checkDaemon();
	if (!running) {
		try {
			const result = await spawnDaemon({
				port: args.port,
				opencodeUrl: `http://localhost:${args.ocPort}`,
			});
			stdout.write(
				`Daemon started (pid: ${result.pid}, port: ${result.port})\n`,
			);
			running = true;
		} catch (err) {
			const message = formatErrorDetail(err);
			if (
				message.includes("EADDRINUSE") ||
				message.includes("address already in use")
			) {
				stderr.write(`Port ${args.port} is already in use.\n`);
				stderr.write("Try a different port: --port <number>\n");
			} else {
				stderr.write(`Failed to start daemon: ${message}\n`);
			}
			exit(1);
			return;
		}
	}

	// 2. Register current directory as a project
	const registerResponse = await ipcSend({
		cmd: "add_project",
		directory: cwd,
	});
	const slug = registerResponse.ok
		? (registerResponse.slug as string)
		: undefined;

	// 3. Build URL (check daemon TLS status for correct scheme)
	const statusResponse = await ipcSend({ cmd: "get_status" });
	const scheme = statusResponse["tlsEnabled"] === true ? "https" : "http";
	// 3b. Build URLs with Tailscale priority (consistent with interactive path)
	const tsIP = getTsIP();
	const lanIP = getAddr();
	const primaryIP = tsIP ?? lanIP ?? "localhost";
	const url = `${scheme}://${primaryIP}:${args.port}`;
	const tlsActive = statusResponse["tlsEnabled"] === true;

	// 4. Show QR code with optional setup caption
	if (primaryIP !== "localhost") {
		const qrUrl = tlsActive
			? `http://${primaryIP}:${args.port + 1}/setup`
			: url;
		const qrCode = qr(qrUrl);
		if (qrCode) {
			stdout.write("\n");
			stdout.write(qrCode);
			if (tlsActive) {
				stdout.write(
					`  Scan or visit: http://${primaryIP}:${args.port + 1}/setup\n`,
				);
			}
			stdout.write("\n");
		}
	}

	// 5. Display connection info
	stdout.write("\n");
	stdout.write("conduit\n");
	stdout.write(`  URL: ${url}\n`);
	if (tsIP && lanIP && tsIP !== lanIP) {
		stdout.write(`  Local: ${scheme}://${lanIP}:${args.port}\n`);
	}

	if (slug) {
		stdout.write(`  Project: ${slug} (${cwd})\n`);
	}

	// 6. Show PIN info
	stdout.write("Tip: Set a PIN for security: conduit --pin <4-8 digits>\n");
	stdout.write("\n");
}
