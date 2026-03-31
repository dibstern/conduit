// ─── Frontend Logger ─────────────────────────────────────────────────────────
// Lightweight browser-side logger matching the backend Logger interface shape.
// Maps levels to console.* methods; debug/verbose only emit when the "debug"
// feature flag is active (?feats=debug / Settings toggle / Ctrl+Shift+D).

import { featureFlags } from "../stores/feature-flags.svelte.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Browser-side logger interface.
 * Mirrors the backend `Logger` from `src/lib/logger.ts` so both sides share
 * the same method-per-level calling convention.
 */
export interface FrontendLogger {
	debug(...args: unknown[]): void;
	verbose(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	child(tag: string): FrontendLogger;
}

export interface FrontendLoggerOptions {
	/** Called after console.error(); use for DEV-only invariant throws. */
	onError?: (...args: unknown[]) => void;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/** Create a tagged browser logger. Child loggers chain tags: `[ws:parse]`. */
export function createFrontendLogger(
	tag: string,
	options?: FrontendLoggerOptions,
): FrontendLogger {
	const prefix = `[${tag}]`;
	const onError = options?.onError;

	return {
		debug(...args: unknown[]) {
			if (featureFlags.debug) console.debug(prefix, ...args);
		},
		verbose(...args: unknown[]) {
			if (featureFlags.debug) console.debug(prefix, ...args);
		},
		info(...args: unknown[]) {
			console.info(prefix, ...args);
		},
		warn(...args: unknown[]) {
			console.warn(prefix, ...args);
		},
		error(...args: unknown[]) {
			console.error(prefix, ...args);
			onError?.(...args);
		},
		child(childTag: string) {
			return createFrontendLogger(`${tag}:${childTag}`, options);
		},
	};
}

// ─── Silent Logger ──────────────────────────────────────────────────────────

const noop = () => {};

/** No-op logger for tests or contexts where logging should be suppressed. */
export function createSilentFrontendLogger(): FrontendLogger {
	return {
		debug: noop,
		verbose: noop,
		info: noop,
		warn: noop,
		error: noop,
		child: () => createSilentFrontendLogger(),
	};
}
