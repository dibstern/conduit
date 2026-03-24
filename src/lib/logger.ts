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

/**
 * The stream where final formatted output lands (JSON lines or pretty text).
 * For JSON: a pino.destination (sync, writes to fd 1).
 * For pretty: a PassThrough that pino-pretty pipes into (then piped to stdout).
 */
let outputStream: Writable;

/** The root pino instance. Recreated when level or format changes. */
let rootPino: PinoInstance = buildPino(currentLevel, currentFormat);

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
			level,
			customLevels: CUSTOM_LEVELS,
			useOnlyCustomLevels: false,
		},
		destination,
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

function wrapPino(p: PinoInstance): Logger {
	return {
		debug: (...args) => p.debug(formatArgs(args)),
		verbose: (...args) => p.verbose(formatArgs(args)),
		info: (...args) => p.info(formatArgs(args)),
		warn: (...args) => p.warn(formatArgs(args)),
		error: (...args) => p.error(formatArgs(args)),
		child: (childTag) => {
			const bindings = p.bindings() as { component?: string[] };
			const components = [...(bindings.component ?? []), childTag];
			return wrapPino(p.child({ component: components }));
		},
	};
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Set the minimum log level. Messages below this level are suppressed.
 * Recreates the root pino instance so all future loggers use the new level.
 */
export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
	rootPino = buildPino(currentLevel, currentFormat);
}

/** Get the current log level. */
export function getLogLevel(): LogLevel {
	return currentLevel;
}

/**
 * Set the output format.
 * - "pretty": column-aligned `[tag] [subtag]  message` for foreground/human use.
 * - "json": structured JSON lines for daemon/machine use.
 */
export function setLogFormat(format: LogFormat): void {
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

	const pinoChild = rootPino.child({ component: [tag] });
	return wrapPino(pinoChild);
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
