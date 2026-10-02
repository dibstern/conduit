// Shared utilities used by CLI commands: arg parsing, network, QR, formatting.

import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_CONFIG_DIR,
	DEFAULT_OC_PORT,
	DEFAULT_PORT,
	ENV,
} from "../lib/env.js";
import type { LogFormat, LogLevel } from "../lib/logger.js";

export { DEFAULT_CONFIG_DIR, DEFAULT_OC_PORT, DEFAULT_PORT };
export const DEFAULT_SOCKET_PATH = join(DEFAULT_CONFIG_DIR, "relay.sock");

export interface ParsedArgs {
	command:
		| "default"
		| "doctor"
		| "serve"
		| "status"
		| "stop"
		| "pin"
		| "add"
		| "remove"
		| "list"
		| "title"
		| "instance"
		| "service"
		| "help";
	cwd: string;
	port: number;
	/** True when --port was explicitly provided on the command line. */
	portExplicit?: boolean;
	/** Bind address. Undefined means "let the daemon decide" (127.0.0.1 without TLS, 0.0.0.0 with TLS). */
	host?: string;
	ocPort: number;
	pin?: string;
	addPath?: string;
	title?: string;
	instanceAction?: "list" | "add" | "remove" | "start" | "stop" | "status";
	instanceName?: string;
	instancePort?: number;
	instanceManaged?: boolean;
	instanceUrl?: string;
	serviceAction?: string;
	noHttps: boolean;
	skipPerms: boolean;
	/** Claude Code config dir (CLAUDE_CONFIG_DIR) for Claude SDK subprocesses; persisted in daemon.json. */
	claudeConfigDir?: string;
	logLevel: LogLevel;
	logFormat?: LogFormat;
}

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		command: "default",
		cwd: process.cwd(),
		port: DEFAULT_PORT,
		...(ENV.hostExplicit ? { host: ENV.host } : {}),
		ocPort: DEFAULT_OC_PORT,
		noHttps: false,
		skipPerms: false,
		logLevel: ENV.logLevel,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		switch (arg) {
			case "service": {
				result.command = "service";
				const action = argv[i + 1];
				if (action && !action.startsWith("-")) {
					result.serviceAction = action;
					i++;
				}
				break;
			}

			case "doctor":
			case "--doctor":
				result.command = "doctor";
				break;

			case "serve":
			case "--foreground":
				result.command = "serve";
				break;

			case "--status":
				result.command = "status";
				break;

			case "stop":
			case "--stop":
				result.command = "stop";
				break;

			case "--pin": {
				result.command = "pin";
				const val = argv[i + 1];
				if (val !== undefined && !val.startsWith("--")) {
					result.pin = val;
					i++;
				}
				break;
			}

			case "--add": {
				result.command = "add";
				const val = argv[i + 1];
				if (val !== undefined && !val.startsWith("--")) {
					result.addPath = val;
					i++;
				}
				break;
			}

			case "--remove":
				result.command = "remove";
				break;

			case "--list":
				result.command = "list";
				break;

			case "--title": {
				result.command = "title";
				const val = argv[i + 1];
				if (val !== undefined && !val.startsWith("--")) {
					result.title = val;
					i++;
				}
				break;
			}

			case "--port":
			case "-p": {
				const val = argv[i + 1];
				if (val === undefined) break;
				const port = Number.parseInt(val, 10);
				if (!Number.isNaN(port) && port >= 1 && port <= 65535) {
					result.port = port;
					result.portExplicit = true;
				}
				i++;
				break;
			}

			case "--host":
			case "-H": {
				const val = argv[i + 1];
				if (val !== undefined && !val.startsWith("--")) {
					result.host = val;
					i++;
				}
				break;
			}

			case "--claude-config-dir": {
				const val = argv[i + 1];
				if (val !== undefined && !val.startsWith("--")) {
					result.claudeConfigDir = val;
					i++;
				}
				break;
			}

			case "--oc-port": {
				const val = argv[i + 1];
				if (val === undefined) break;
				const port = Number.parseInt(val, 10);
				if (!Number.isNaN(port) && port >= 1 && port <= 65535) {
					result.ocPort = port;
				}
				i++;
				break;
			}

			case "--no-https":
				result.noHttps = true;
				break;

			case "--dangerously-skip-permissions":
				result.skipPerms = true;
				break;

			case "--managed":
				result.instanceManaged = true;
				break;

			case "--url": {
				const val = argv[i + 1];
				if (val && !val.startsWith("--")) {
					result.instanceUrl = val;
					i++;
				} else {
					console.warn(
						"Warning: --url flag provided without a value — ignoring",
					);
				}
				break;
			}

			case "--instance": {
				result.command = "instance";
				const action = argv[i + 1];
				if (action && !action.startsWith("--")) {
					const validActions = [
						"list",
						"add",
						"remove",
						"start",
						"stop",
						"status",
					] as const;
					if (validActions.includes(action as (typeof validActions)[number])) {
						result.instanceAction = action as Exclude<
							ParsedArgs["instanceAction"],
							undefined
						>;
					}
					i++;
					// For add/remove/start/stop/status, next arg is the name/id
					const nameOrId = argv[i + 1];
					if (nameOrId && !nameOrId.startsWith("--")) {
						result.instanceName = nameOrId;
						i++;
					}
				}
				break;
			}

			case "--log-level": {
				const val = argv[i + 1];
				const valid = ["error", "warn", "info", "verbose", "debug"];
				if (val && valid.includes(val)) {
					result.logLevel = val as LogLevel;
				}
				i++;
				break;
			}

			case "--log-format": {
				const val = argv[i + 1];
				if (val === "json" || val === "pretty") {
					result.logFormat = val;
				}
				i++;
				break;
			}

			case "--help":
			case "-h":
				result.command = "help";
				break;

			default:
				// Unknown flag — ignore
				break;
		}
	}

	// Post-processing: if command is "instance" and port was explicitly set,
	// use it as instancePort (handles --port before --instance ordering)
	if (
		result.command === "instance" &&
		(result.port !== DEFAULT_PORT || result.portExplicit)
	) {
		result.instancePort = result.port;
		result.port = DEFAULT_PORT;
	}

	return result;
}

/** Return the first non-internal IPv4 address, or null. */
export function getNetworkAddress(): string | null {
	const interfaces = networkInterfaces();
	for (const addrs of Object.values(interfaces)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				return addr.address;
			}
		}
	}
	return null;
}

/**
 * Generate a QR code string from a URL using qrcode-terminal.
 * Returns the generated QR art as a string.
 *
 * Uses createRequire because qrcode-terminal is a CJS-only package
 * and the project uses ESM ("type": "module").
 */
export function generateQR(url: string): string {
	try {
		const esmRequire = createRequire(import.meta.url);
		const qrcode = esmRequire("qrcode-terminal") as {
			generate(
				url: string,
				opts: { small: boolean },
				cb: (code: string) => void,
			): void;
		};
		let result = "";
		qrcode.generate(url, { small: true }, (code: string) => {
			result = code;
		});
		return result;
	} catch {
		return `[QR code for: ${url}]`;
	}
}

export const HELP_TEXT = `Usage: conduit [command] [options]

  With no command, registers the current directory and prints its server URL.
  Start the server with conduit serve or conduit service install.

Commands:
  serve                 Run the server in this process until stopped
  stop                  Shut down the server and its managed processes
  service install       Install a launchd/systemd user service (accepts server options)
  service uninstall     Stop and remove the user service
  service status        Show service state, PID and log paths
  doctor                Check registered projects' shell env and tools locally

Options:
  --status              Show server status
  --stop                Alias for stop
  --pin <PIN>           Set/update PIN (4-8 digit)
  --add <path>          Add project by path
  --remove              Remove current project
  --list                List all projects
  --title <name>        Set project display title
  --instance <action>   Manage OpenCode instances
                        Actions: list, add, remove, start, stop, status
                        Managed:   --instance add work --port 4097 --managed
                        Unmanaged: --instance add remote --url http://host:4096
  -p, --port <port>     HTTP server port (default: 2633)
                        When used with --instance, sets the instance port
  -H, --host <addr>     Bind address (default: 127.0.0.1, or HOST env var)
  --oc-port <port>      OpenCode server port (default: 4096)
  --claude-config-dir <path>
                        Claude Code config dir (CLAUDE_CONFIG_DIR) for Claude
                        sessions; persisted in daemon.json for future starts
  --managed             Mark as managed (spawned by relay-daemon; used with --instance add)
  --url <url>           External URL for unmanaged instances (used with --instance add)
  --log-level <level>   Set log level: error, warn, info (default), verbose, debug
  --log-format <format> Set output format: pretty (default), json
  --no-https            Disable TLS
  --dangerously-skip-permissions
                        Skip permission prompts (requires --pin)
  -h, --help            Show this help
`;

export function formatUptime(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600)
		return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
}
