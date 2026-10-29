/**
 * Structured logger with tag hierarchy and column-aligned output.
 *
 * Backend: pino with custom "verbose" level (25, between debug and info).
 *
 * Usage:
 *   const log = createLogger('relay');
 *   const sseLog = log.child('sse');
 *   sseLog.info('Connected');  // pretty → "[relay] [sse]          Connected"
 *                              // json   → {"level":30,"component":["relay","sse"],"msg":"Connected"}
 */

import { appendFileSync, renameSync, statSync } from "node:fs";
import { PassThrough, type Writable } from "node:stream";
import type { DestinationStream, LogFn } from "pino";
import pino from "pino";
import pinoPretty from "pino-pretty";

export interface Logger {
	debug(...args: unknown[]): void;
	verbose(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	child(tag: string): Logger;
}

export type LogLevel = "debug" | "verbose" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";

/**
 * Fixed column width for the tag portion of log lines.
 * The longest known tag chain is "[relay] [status-poller]" (24 chars).
 * We pad to 26 to leave a 2-char margin before the message body.
 */
const TAG_COLUMN_WIDTH = 26;

const CUSTOM_LEVELS = { verbose: 25 };

/**
 * Internal pino instance type. We use a loose type because pino's generic
 * type system for custom levels is complex and fights `exactOptionalPropertyTypes`.
 */
interface PinoInstance {
	debug: LogFn;
	info: LogFn;
	warn: LogFn;
	error: LogFn;
	verbose: LogFn;
	child(bindings: pino.Bindings): PinoInstance;
	bindings(): pino.Bindings;
	level: string;
}

/** Current configuration — used when rebuilding the root pino instance. */
let currentLevel: LogLevel = "info";
let currentFormat: LogFormat = "json";

let logFile: { path: string; size: number; maxBytes: number } | undefined;

// Shared by every root so attaching a file also reaches existing child loggers.
const fileDestination: DestinationStream = {
	write(data: string) {
		if (!logFile) return;
		try {
			const bytes = Buffer.byteLength(data);
			if (logFile.size + bytes > logFile.maxBytes) {
				renameSync(logFile.path, `${logFile.path}.1`);
				logFile.size = 0;
			}
			appendFileSync(logFile.path, data);
			logFile.size += bytes;
		} catch {
			// File failures must never interrupt stdout logging or callers.
		}
	},
};

/**
 * The stream where final formatted output lands (JSON lines or pretty text).
 * For JSON: a pino.destination (sync, writes to fd 1).
 * For pretty: a PassThrough that pino-pretty pipes into (then piped to stdout).
 */
let outputStream: Writable;

/** The root pino instance. Lazy-initialized on first use to avoid paying
 *  pino + pino-pretty startup cost (~50-100ms) at module load time.
 *  Recreated when level or format changes via setLogLevel/setLogFormat. */
let rootPino: PinoInstance | null = null;

function getRootPino(): PinoInstance {
	if (!rootPino) rootPino = buildPino(currentLevel, currentFormat);
	return rootPino;
}

function padTag(tag: string): string {
	return tag.length >= TAG_COLUMN_WIDTH
		? `${tag} `
		: `${tag}${" ".repeat(TAG_COLUMN_WIDTH - tag.length)}`;
}

function formatComponentTag(component: string[]): string {
	return component.map((c) => `[${c}]`).join(" ");
}

function buildPrettyDestination(output: Writable): DestinationStream {
	return pinoPretty({
		colorize: false,
		ignore: "pid,hostname,component,time,level",
		messageFormat: (log: Record<string, unknown>, messageKey: string) => {
			const component = (log["component"] as string[] | undefined) ?? [];
			const tag = formatComponentTag(component);
			const padded = padTag(tag);
			return `${padded}${log[messageKey]}`;
		},
		customLevels: "verbose:25",
		hideObject: true,
		destination: output,
	});
}

function buildPino(level: LogLevel, format: LogFormat): PinoInstance {
	let destination: DestinationStream;

	if (format === "pretty") {
		outputStream = new PassThrough();
		outputStream.pipe(process.stdout);
		destination = buildPrettyDestination(outputStream);
	} else {
		const dest = pino.destination({ sync: true });
		outputStream = dest as unknown as Writable;
		destination = dest;
	}

	return pino(
		{
			// The file always receives warnings, even when stdout is set to error.
			level: level === "error" ? "warn" : level,
			customLevels: CUSTOM_LEVELS,
			useOnlyCustomLevels: false,
		},
		pino.multistream<LogLevel>(
			[
				{ level, stream: destination },
				{ level: "warn", stream: fileDestination },
			],
			{ levels: CUSTOM_LEVELS },
		),
	) as unknown as PinoInstance;
}

/**
 * Format variadic args into a single message string.
 * pino expects (msg: string) or (obj, msg) — we flatten everything to a string
 * to preserve the existing Logger interface that accepts (...args: unknown[]).
 */
function formatArgs(args: unknown[]): string {
	return args
		.map((a) => {
			if (a instanceof Error) return a.stack ?? a.message;
			if (typeof a === "string") return a;
			try {
				return JSON.stringify(a);
			} catch {
				return String(a);
			}
		})
		.join(" ");
}

/**
 * A child of whichever root is current. setLogLevel and setLogFormat replace
 * the root, so a child captured once (a module-level logger, made before the
 * daemon applies its flags) would keep logging JSON at the startup level.
 */
function currentChild(component: string[]): () => PinoInstance {
	let root: PinoInstance | undefined;
	let child: PinoInstance | undefined;
	return () => {
		const current = getRootPino();
		if (current !== root || !child) {
			root = current;
			child = current.child({ component });
		}
		return child;
	};
}

function wrapPino(component: string[]): Logger {
	const p = currentChild(component);
	return {
		debug: (...args) => p().debug(formatArgs(args)),
		verbose: (...args) => p().verbose(formatArgs(args)),
		info: (...args) => p().info(formatArgs(args)),
		warn: (...args) => p().warn(formatArgs(args)),
		error: (...args) => p().error(formatArgs(args)),
		child: (childTag) => wrapPino([...component, childTag]),
	};
}

/**
 * Set the minimum stdout log level. The file still receives warn and above.
 * Recreates the root pino instance so all future loggers use the new level.
 */
export function setLogLevel(level: LogLevel): void {
	if (level === currentLevel && rootPino) return;
	currentLevel = level;
	rootPino = buildPino(currentLevel, currentFormat);
}

/** Get the current log level. */
export function getLogLevel(): LogLevel {
	return currentLevel;
}

/** Attach a synchronous JSON warning/error log with one rotating backup. */
export function setLogFile(path: string, maxBytes = 10 * 1024 * 1024): void {
	logFile = undefined;
	try {
		appendFileSync(path, "");
		logFile = { path, size: statSync(path).size, maxBytes };
	} catch {
		// An unavailable file must not prevent the daemon from starting.
	}
}

/**
 * Set the output format.
 * - "pretty": column-aligned `[tag] [subtag]  message` for foreground/human use.
 * - "json": structured JSON lines for daemon/machine use.
 */
export function setLogFormat(format: LogFormat): void {
	if (format === currentFormat && rootPino) return;
	currentFormat = format;
	rootPino = buildPino(currentLevel, currentFormat);
}

/**
 * Create a logger with the given tag.
 *
 * @param tag - Component identifier (e.g. "relay", "daemon")
 * @param parent - Optional parent logger for external composition. Prefer
 *   `logger.child(tag)` when you have access to the parent — it provides
 *   column-aligned output. The `parent` parameter delegates formatting to
 *   the parent, so alignment depends on the parent's tag width.
 */
export function createLogger(tag: string, parent?: Logger): Logger {
	if (parent) {
		const bracket = `[${tag}]`;
		return {
			debug: (...args) => parent.debug(bracket, ...args),
			verbose: (...args) => parent.verbose(bracket, ...args),
			info: (...args) => parent.info(bracket, ...args),
			warn: (...args) => parent.warn(bracket, ...args),
			error: (...args) => parent.error(bracket, ...args),
			child: (childTag) => createLogger(childTag, createLogger(tag, parent)),
		};
	}

	return wrapPino([tag]);
}

/**
 * Create a silent logger (all methods are no-ops).
 * Useful as a default when logging is optional.
 */
export function createSilentLogger(): Logger {
	const noop = () => {};
	const silent: Logger = {
		debug: noop,
		verbose: noop,
		info: noop,
		warn: noop,
		error: noop,
		child: () => silent,
	};
	return silent;
}

/**
 * Create a mock logger for testing. All methods are plain functions
 * that can be wrapped with vi.fn() in tests.
 */
export function createTestLogger(): Logger {
	const logger: Logger = {
		debug: () => {},
		verbose: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => createTestLogger(),
	};
	return logger;
}

/**
 * Get the current output stream (for testing).
 * For JSON format: the pino destination (writes JSON lines).
 * For pretty format: the PassThrough stream pino-pretty writes into.
 * @internal — not part of the public API.
 */
export function _getOutputStream(): Writable {
	return outputStream;
}

/**
 * Return a getter for the raw Pino child for the given tag. Call it per log:
 * it follows the root that setLogLevel/setLogFormat rebuild.
 *
 * Unlike `createLogger()`, this does **not** wrap the instance with the
 * project's `Logger` interface — callers get the native pino API whose
 * `.child(bindings)` accepts `Record<string, unknown>`.
 *
 * Primary consumer: `PinoLoggerLive` in `src/lib/domain/daemon/Layers/pino-logger-layer.ts`.
 * @internal
 */
export function _getRawPinoChild(tag: string): () => PinoInstance {
	return currentChild([tag]);
}
