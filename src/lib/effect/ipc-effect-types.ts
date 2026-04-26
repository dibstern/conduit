// ─── IPC Effect Handler Types ────────────────────────────────────────────────
// Type definitions for Effect-returning IPC handlers that pair with the
// existing IPCCommandSchema (19-command Schema.Union discriminated on `cmd`).
//
// This module is deliberately thin — just types and re-exports.
// The actual handler implementations live in Task 8.

import type { Effect } from "effect";
import type { IPCCommand, IPCResponse } from "../types.js";

// ─── Re-exports from existing protocol ──────────────────────────────────────

export {
	IPCCommandSchema,
	parseCommand,
	validateCommand,
} from "../daemon/ipc-protocol.js";

// ─── Handler type ───────────────────────────────────────────────────────────

/**
 * An Effect-returning IPC command handler.
 *
 * Takes an IPCCommand and produces an IPCResponse inside an Effect.
 * The error channel is `never` — handlers must handle their own errors
 * and return appropriate IPCResponse values.
 *
 * @typeParam R - The Effect context (service dependencies). Defaults to
 *               `never` (no dependencies required).
 */
export type IpcEffectHandler<R = never> = (
	cmd: IPCCommand,
) => Effect.Effect<IPCResponse, never, R>;

// ─── Registry type ──────────────────────────────────────────────────────────

/**
 * A record mapping command names to their Effect-returning handlers.
 *
 * @typeParam R - The Effect context shared by all handlers in the registry.
 */
export type IpcHandlerRegistry<R> = Record<string, IpcEffectHandler<R>>;
