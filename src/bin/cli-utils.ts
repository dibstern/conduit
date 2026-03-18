// ─── CLI Utilities ──────────────────────────────────────────────────────────
// Shared utilities used by CLI commands: arg parsing, IPC, network, QR, formatting.

import { createRequire } from "node:module";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import {
	DEFAULT_CONFIG_DIR,
	DEFAULT_OC_PORT,
	DEFAULT_PORT,
	ENV,
} from "../lib/env.js";
import type { LogFormat, LogLevel } from "../lib/logger.js";
import type { IPCCommand, IPCResponse } from "../lib/types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export { DEFAULT_CONFIG_DIR, DEFAULT_OC_PORT, DEFAULT_PORT };
export const DEFAULT_SOCKET_PATH = join(DEFAULT_CONFIG_DIR, "relay.sock");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ParsedArgs {
	command:
		| "default"
		| "daemon"
		| "foreground"
		| "status"
		| "stop"
		| "pin"
		| "add"
		| "remove"
		| "list"
		| "title"
		| "instance"
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
	noUpdate: boolean;
	debug: boolean;
	yes: boolean;
	noHttps: boolean;
	skipPerms: boolean;
	logLevel: LogLevel;
	logFormat?: LogFormat;
}

// ─── Arg Parsing ────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		command: "default",
		cwd: process.cwd(),
		port: DEFAULT_PORT,
		...(ENV.hostExplicit ? { host: ENV.host } : {}),
		ocPort: DEFAULT_OC_PORT,
		noUpdate: false,
		debug: false,
		yes: false,
		noHttps: false,
		skipPerms: false,
		logLevel: ENV.logLevel,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		switch (arg) {
			case "--daemon":
				result.command = "daemon";
				break;

			case "--foreground":
				result.command = "foreground";
				break;

			case "--status":
				result.command = "status";
				break;

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

			case "--no-update":
				result.noUpdate = true;
				break;

			case "--debug":
				result.debug = true;
				break;

			case "-y":
			case "--yes":
				result.yes = true;
				break;

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

// ─── IPC Client ─────────────────────────────────────────────────────────────

/** Send a single IPC command to the daemon's Unix socket and return the response. */
export function sendIPCCommand(
	socketPath: string,
	cmd: IPCCommand,
): Promise<IPCResponse> {
	return new Promise((resolve, reject) => {
		const client = connect(socketPath);
		let buffer = "";

		const timeout = setTimeout(() => {
			client.destroy();
			reject(new Error("IPC command timed out"));
		}, 5000);

		client.on("connect", () => {
			client.write(`${JSON.stringify(cmd)}\n`);
		});

		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf-8");
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex !== -1) {
				clearTimeout(timeout);
				const line = buffer.slice(0, newlineIndex).trim();
				client.destroy();
				try {
					resolve(JSON.parse(line));
				} catch {
					reject(new Error(`Invalid JSON response: ${line}`));
				}
			}
		});

		client.on("error", (err: Error) => {
			clearTimeout(timeout);
			reject(err);
		});
	});
}

// ─── Network Address ────────────────────────────────────────────────────────

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

// ─── QR Code Generation ────────────────────────────────────────────────────

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

// ─── Help Text ──────────────────────────────────────────────────────────────

export const HELP_TEXT = `Usage: opencode-relay [options]

  With no flags, launches the interactive setup wizard and main menu.

Options:
  --status              Show daemon status
  --stop                Stop daemon
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
  --managed             Mark as managed (spawned by relay-daemon; used with --instance add)
  --url <url>           External URL for unmanaged instances (used with --instance add)
  --log-level <level>   Set log level: error, warn, info (default), verbose, debug
  --log-format <format> Set output format: pretty (default foreground), json (default daemon)
  --no-update           Skip version check
  --debug               Enable debug mode
  -y, --yes             Skip interactive prompts (auto-accept defaults)
  --no-https            Disable TLS
  --dangerously-skip-permissions
                        Skip permission prompts (requires --pin)
  --foreground           Run daemon in foreground (for dev with tsx watch)
  -h, --help            Show this help
`;

// ─── Formatting Helpers ─────────────────────────────────────────────────────

export function formatUptime(seconds: number): string {
	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600)
		return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${mins}m`;
}
