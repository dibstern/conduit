// src/lib/provider/claude/claude-permission-bridge.ts
/**
 * SDK adapter for Claude's Promise-shaped `canUseTool` callback.
 *
 * Permission/question core logic lives in ClaudePermissionService. This file is
 * intentionally the only Promise boundary: the Claude SDK requires a Promise
 * callback and AbortSignal-aware unblocking.
 */
import { Effect } from "effect";
import type { EventSink, PermissionDecision } from "../types.js";
import {
	ClaudePermissionService,
	type ClaudePermissionServiceDeps,
} from "./claude-permission-service.js";
import type {
	CanUseTool,
	ClaudeSessionContext,
	PermissionResult,
} from "./types.js";

type CanUseToolOptions = Parameters<CanUseTool>[2];

export interface ClaudePermissionBridgeDeps {
	readonly sink?: EventSink;
	readonly service?: ClaudePermissionService;
}

function runPermissionRequestAtSdkBoundary<T>(
	effect: Effect.Effect<T, unknown>,
): Promise<T> {
	return Effect.runPromise(effect);
}

export class ClaudePermissionBridge {
	private readonly service: ClaudePermissionService;

	constructor(deps: ClaudePermissionBridgeDeps = {}) {
		const serviceDeps: ClaudePermissionServiceDeps = {
			...(deps.sink ? { sink: deps.sink } : {}),
		};
		this.service = deps.service ?? new ClaudePermissionService(serviceDeps);
	}

	createCanUseTool(ctx: ClaudeSessionContext): CanUseTool {
		return async (
			toolName: string,
			toolInput: Record<string, unknown>,
			options: CanUseToolOptions,
		): Promise<PermissionResult> => {
			return this.canUseTool(ctx, toolName, toolInput, options);
		};
	}

	async canUseTool(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: CanUseToolOptions,
	): Promise<PermissionResult> {
		try {
			return await runPermissionRequestAtSdkBoundary(
				this.service.handlePermissionEffect(ctx, toolName, toolInput, options),
			);
		} catch {
			return {
				behavior: "deny",
				message: "Turn interrupted",
			};
		}
	}

	resolvePermission(
		ctx: ClaudeSessionContext,
		requestId: string,
		decision: PermissionDecision,
	): Effect.Effect<void, unknown> {
		return this.service.resolvePermission(ctx, requestId, decision);
	}
}
