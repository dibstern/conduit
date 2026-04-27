// ─── PinoLoggerLive ─────────────────────────────────────────────────────────
// Bridges Effect.log* (logInfo, logWarning, logError, etc.) to Pino.
//
// Effect.annotateLogs annotations are forwarded as Pino child logger bindings
// so entity IDs (sessionId, cmd, component, etc.) appear in structured output.
// Effect log spans are forwarded as a "span" binding.

import { Cause, HashMap, type Layer, List, Logger, Option } from "effect";
import type { Logger as PinoLogger } from "pino";

/**
 * Create a Layer that replaces Effect's default logger with one that routes
 * to the given Pino instance. Log levels are mapped:
 *
 *   Effect.logDebug / Effect.logTrace  ->  pino.debug
 *   Effect.logInfo                      ->  pino.info
 *   Effect.logWarning                   ->  pino.warn
 *   Effect.logError / Effect.logFatal   ->  pino.error
 *
 * Annotations from Effect.annotateLogs are forwarded as Pino child bindings.
 * The most recent span label (from Effect.withLogSpan) is included as "span".
 */
export const makePinoLoggerLive = (pino: PinoLogger): Layer.Layer<never> =>
	Logger.replace(
		Logger.defaultLogger,
		Logger.make(({ logLevel, message, annotations, spans, cause }) => {
			// message is an array of parts — join them into a single string
			const text = Array.isArray(message)
				? message.map((m) => (typeof m === "string" ? m : String(m))).join(" ")
				: typeof message === "string"
					? message
					: String(message);

			// Convert Effect annotations HashMap to a plain object for Pino bindings
			const bindings: Record<string, unknown> = {};
			HashMap.forEach(annotations, (value, key) => {
				bindings[key] = value;
			});

			// Add the most recent span label if present
			if (!List.isNil(spans)) {
				const lastOpt = List.last(spans);
				if (Option.isSome(lastOpt)) {
					bindings["span"] = lastOpt.value.label;
				}
			}

			// Create child logger with bindings, or use root if no bindings
			const hasBindings = Object.keys(bindings).length > 0;
			const target = hasBindings ? pino.child(bindings) : pino;

			switch (logLevel._tag) {
				case "Debug":
				case "Trace":
					target.debug(text);
					break;
				case "Info":
					target.info(text);
					break;
				case "Warning":
					target.warn(text);
					break;
				case "Error":
				case "Fatal":
					if (!Cause.isEmpty(cause)) {
						target.error({ err: Cause.pretty(cause) }, text);
					} else {
						target.error(text);
					}
					break;
				default:
					target.info(text);
			}
		}),
	);

// ─── Pre-built singleton for production use ─────────────────────────────────
// Uses the existing Pino logger infrastructure with an "effect" tag.

import { createLogger } from "../logger.js";

/**
 * Production PinoLoggerLive layer — routes all Effect.log* calls through
 * the project's standard Pino logger tagged as "effect".
 */
export const PinoLoggerLive: Layer.Layer<never> = makePinoLoggerLive(
	createLogger("effect") as unknown as PinoLogger,
);
