// src/lib/provider/claude/claude-permission-bridge.ts
/**
 * ClaudePermissionBridge converts the Claude Agent SDK's pull-based
 * permission model (a canUseTool callback that blocks) into conduit's
 * push-based permission model (EventSink.requestPermission()).
 *
 * Flow:
 *   1. SDK calls canUseTool(toolName, input, { signal, toolUseID })
 *   2. Bridge creates a PendingApproval and stores it on ctx
 *   3. Bridge calls eventSink.requestPermission() -- this emits permission.asked
 *      and returns a promise that the EventSink will resolve when the UI
 *      delivers the decision (via resolvePermission() on the adapter)
 *   4. Bridge awaits either the sink promise or the abort signal
 *   5. Bridge returns the SDK PermissionResult
 *
 * The bridge exposes `resolvePermission()` so the adapter can route the
 * UI's decision back to the bridge. Internally this just completes the
 * pending entry -- the actual SDK callback is unblocked by the EventSink's
 * requestPermission() promise resolution.
 */
import { randomUUID } from "node:crypto";
import type { EventSink, PermissionDecision } from "../types.js";
import type {
	CanUseTool,
	ClaudeSessionContext,
	PendingApproval,
	PermissionResult,
} from "./types.js";

export interface ClaudePermissionBridgeDeps {
	readonly sink: EventSink;
}

// AbortSignal-aware promise wrapper. When the abort signal fires,
// the promise rejects cleanly so the SDK's canUseTool callback unblocks.
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("Aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error("Aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(v) => {
				signal.removeEventListener("abort", onAbort);
				resolve(v);
			},
			(e) => {
				signal.removeEventListener("abort", onAbort);
				reject(e as Error);
			},
		);
	});
}

export class ClaudePermissionBridge {
	constructor(private readonly deps: ClaudePermissionBridgeDeps) {}

	/**
	 * Factory method that returns the exact SDK CanUseTool signature.
	 * Called once per session to produce the callback passed to query() options.
	 * The returned function captures ctx so the SDK doesn't need to know about
	 * ClaudeSessionContext.
	 */
	createCanUseTool(ctx: ClaudeSessionContext): CanUseTool {
		return async (
			toolName: string,
			toolInput: Record<string, unknown>,
			options: { signal: AbortSignal; toolUseID: string },
		): Promise<PermissionResult> => {
			return this._handlePermission(ctx, toolName, toolInput, options);
		};
	}

	/**
	 * Internal permission handler -- shared by createCanUseTool and legacy canUseTool.
	 */
	private async _handlePermission(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: { signal: AbortSignal; toolUseID: string },
	): Promise<PermissionResult> {
		const requestId = randomUUID();
		const createdAt = new Date().toISOString();

		// Create a deferred for this specific permission request.
		// The resolve/reject are captured by the Promise constructor and
		// assigned synchronously before the pending record is created.
		let resolveDeferred: (decision: PermissionDecision) => void = () => {};
		let rejectDeferred: (error: Error) => void = () => {};
		void new Promise<PermissionDecision>((res, rej) => {
			resolveDeferred = res;
			rejectDeferred = rej;
		});

		const pending: PendingApproval = {
			requestId,
			toolName,
			toolInput: toolInput ?? {},
			createdAt,
			resolve: resolveDeferred,
			reject: rejectDeferred,
		};
		ctx.pendingApprovals.set(requestId, pending);

		try {
			// Fire the permission.asked event and await the sink promise.
			const sinkPromise = this.deps.sink.requestPermission({
				requestId,
				sessionId: ctx.sessionId,
				turnId: ctx.currentTurnId ?? "",
				toolName,
				toolInput: toolInput ?? {},
				providerItemId: options.toolUseID,
			});

			// Race: sink resolution vs abort signal.
			// The sink promise resolves a PermissionResponse object.
			let decision: PermissionDecision;
			try {
				const response = await withAbort(sinkPromise, options.signal);
				// EventSink.requestPermission returns PermissionResponse { decision }
				decision =
					typeof response === "string"
						? response
						: (response as { decision: PermissionDecision }).decision;
			} catch {
				// Abort fired -- return deny to unblock the SDK cleanly.
				ctx.pendingApprovals.delete(requestId);
				return {
					behavior: "deny",
					message: "Turn interrupted",
				};
			}
			ctx.pendingApprovals.delete(requestId);

			if (decision === "once" || decision === "always") {
				return {
					behavior: "allow",
					updatedInput: toolInput ?? {},
				};
			}
			return {
				behavior: "deny",
				message: "User declined tool execution.",
			};
		} finally {
			ctx.pendingApprovals.delete(requestId);
		}
	}

	/**
	 * Legacy convenience method -- delegates to _handlePermission.
	 * Prefer createCanUseTool() for SDK wiring.
	 */
	async canUseTool(
		ctx: ClaudeSessionContext,
		toolName: string,
		toolInput: Record<string, unknown>,
		options: { signal: AbortSignal; toolUseID: string },
	): Promise<PermissionResult> {
		return this._handlePermission(ctx, toolName, toolInput, options);
	}

	/**
	 * Called by the adapter's resolvePermission() to deliver a UI decision
	 * into the pending canUseTool callback. This resolves the PendingApproval's
	 * deferred, but the primary resolution path is through the EventSink.
	 */
	async resolvePermission(
		ctx: ClaudeSessionContext,
		requestId: string,
		decision: PermissionDecision,
	): Promise<void> {
		const pending = ctx.pendingApprovals.get(requestId);
		if (!pending) return;
		pending.resolve(decision);
	}
}
