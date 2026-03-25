// ─── Session Overrides ──────────────────────────────────────────────────────
// Per-session state selected by the user via the UI: agent, model, and
// processing timeout. Each session has independent overrides. A global
// defaultModel provides the fallback when no per-session model is set.

import { TrackedService } from "../daemon/tracked-service.js";

export interface ModelOverride {
	providerID: string;
	modelID: string;
}

const PROCESSING_TIMEOUT_MS = 120_000; // 2 minutes

interface SessionState {
	model?: ModelOverride;
	agent?: string;
	variant?: string;
	modelUserSelected: boolean;
	processingTimer: ReturnType<typeof setTimeout> | null;
	processingTimeoutCallback: (() => void) | null;
}

export class SessionOverrides extends TrackedService {
	/**
	 * Sentinel session ID for backward-compatible shims.
	 * @deprecated — will be removed when all callers migrate to per-session API.
	 */
	private static readonly GLOBAL = "_global";

	/** Global default model — new sessions inherit this when no per-session model is set. */
	defaultModel: ModelOverride | undefined = undefined;

	/** Global default variant (thinking level) — e.g. "low", "medium", "high", "max". */
	defaultVariant: string = "";

	private readonly sessions: Map<string, SessionState> = new Map();

	// ─── Internal ──────────────────────────────────────────────────────────

	private getOrCreate(sessionId: string): SessionState {
		let state = this.sessions.get(sessionId);
		if (!state) {
			state = {
				modelUserSelected: false,
				processingTimer: null,
				processingTimeoutCallback: null,
			};
			this.sessions.set(sessionId, state);
		}
		return state;
	}

	// ─── Default Model ─────────────────────────────────────────────────────

	/** Set the global default model (persisted separately via relay-settings). */
	setDefaultModel(model: ModelOverride): void {
		this.defaultModel = model;
	}

	// ─── Per-Session Model ──────────────────────────────────────────────────

	/** Set model for a session AND mark as user-selected. */
	setModel(sessionId: string, model: ModelOverride): void;
	/** @deprecated — use setModel(sessionId, model) */
	setModel(model: ModelOverride): void;
	setModel(
		sessionIdOrModel: string | ModelOverride,
		model?: ModelOverride,
	): void {
		const [sid, m] =
			typeof sessionIdOrModel === "string"
				? // biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
					[sessionIdOrModel, model!]
				: [SessionOverrides.GLOBAL, sessionIdOrModel];
		const s = this.getOrCreate(sid);
		s.model = m;
		s.modelUserSelected = true;
	}

	/** Set model for display WITHOUT marking as user-selected (auto-detected). */
	setModelDefault(sessionId: string, model: ModelOverride): void;
	/** @deprecated — use setModelDefault(sessionId, model) */
	setModelDefault(model: ModelOverride): void;
	setModelDefault(
		sessionIdOrModel: string | ModelOverride,
		model?: ModelOverride,
	): void {
		const [sid, m] =
			typeof sessionIdOrModel === "string"
				? // biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
					[sessionIdOrModel, model!]
				: [SessionOverrides.GLOBAL, sessionIdOrModel];
		const s = this.getOrCreate(sid);
		s.model = m;
		// Do NOT touch modelUserSelected — preserve existing flag
	}

	/** Get the effective model for a session (per-session override ?? global default). */
	getModel(sessionId: string): ModelOverride | undefined {
		return this.sessions.get(sessionId)?.model ?? this.defaultModel;
	}

	/** Whether the user explicitly selected a model for this session. */
	isModelUserSelected(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.modelUserSelected ?? false;
	}

	// ─── Per-Session Agent ──────────────────────────────────────────────────

	/** Set the agent override for a session. */
	setAgent(sessionId: string, agentId: string): void;
	/** @deprecated — use setAgent(sessionId, agentId) */
	setAgent(agentId: string): void;
	setAgent(sessionIdOrAgentId: string, agentId?: string): void {
		const [sid, agent] = agentId
			? [sessionIdOrAgentId, agentId]
			: [SessionOverrides.GLOBAL, sessionIdOrAgentId];
		this.getOrCreate(sid).agent = agent;
	}

	/** Get the agent override for a session. */
	getAgent(sessionId: string): string | undefined {
		return this.sessions.get(sessionId)?.agent;
	}

	// ─── Per-Session Variant (Thinking Level) ───────────────────────────────

	/** Set the variant (thinking level) for a session. Empty string clears. */
	setVariant(sessionId: string, variant: string): void;
	/** @deprecated — use setVariant(sessionId, variant) */
	setVariant(variant: string): void;
	setVariant(sessionIdOrVariant: string, variant?: string): void {
		if (variant !== undefined) {
			this.getOrCreate(sessionIdOrVariant).variant = variant;
		} else {
			this.getOrCreate(SessionOverrides.GLOBAL).variant = sessionIdOrVariant;
			this.defaultVariant = sessionIdOrVariant;
		}
	}

	/** Get the variant for a session (per-session override ?? global default). */
	getVariant(sessionId: string): string;
	/** @deprecated — use getVariant(sessionId) */
	getVariant(): string;
	getVariant(sessionId?: string): string {
		const sid = sessionId ?? SessionOverrides.GLOBAL;
		return this.sessions.get(sid)?.variant ?? this.defaultVariant;
	}

	// ─── Per-Session Clear ──────────────────────────────────────────────────

	/** Clear all overrides for a specific session (model, agent, timer). */
	clearSession(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (state?.processingTimer) {
			this.clearTrackedTimer(state.processingTimer);
		}
		this.sessions.delete(sessionId);
	}

	// ─── Per-Session Processing Timeout ─────────────────────────────────────

	/** Start a 120s processing timeout for a specific session. Cancels any existing timer for that session. */
	startProcessingTimeout(sessionId: string, onTimeout: () => void): void;
	/** @deprecated — use startProcessingTimeout(sessionId, onTimeout) */
	startProcessingTimeout(onTimeout: () => void): void;
	startProcessingTimeout(
		sessionIdOrCb: string | (() => void),
		onTimeout?: () => void,
	): void {
		const [sid, cb] =
			typeof sessionIdOrCb === "string"
				? // biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
					[sessionIdOrCb, onTimeout!]
				: [SessionOverrides.GLOBAL, sessionIdOrCb];
		const s = this.getOrCreate(sid);
		if (s.processingTimer) {
			this.clearTrackedTimer(s.processingTimer);
		}
		s.processingTimeoutCallback = cb;
		s.processingTimer = this.delayed(() => {
			s.processingTimer = null;
			s.processingTimeoutCallback = null;
			cb();
		}, PROCESSING_TIMEOUT_MS);
	}

	/**
	 * Reset the processing timeout back to 120s for a specific session.
	 * Call this when SSE activity is observed — the timeout acts as an
	 * *inactivity* timer rather than an absolute deadline.
	 * No-op if no timeout is currently active for the session.
	 */
	resetProcessingTimeout(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (state?.processingTimer !== null && state?.processingTimeoutCallback) {
			const cb = state.processingTimeoutCallback;
			this.clearTrackedTimer(state.processingTimer);
			state.processingTimer = this.delayed(() => {
				state.processingTimer = null;
				state.processingTimeoutCallback = null;
				cb();
			}, PROCESSING_TIMEOUT_MS);
		}
	}

	/** Cancel the processing timeout for a specific session. Safe to call when no timer is running. */
	clearProcessingTimeout(sessionId: string): void;
	/** @deprecated — use clearProcessingTimeout(sessionId) */
	clearProcessingTimeout(): void;
	clearProcessingTimeout(sessionId?: string): void {
		const sid = sessionId ?? SessionOverrides.GLOBAL;
		const state = this.sessions.get(sid);
		if (state?.processingTimer) {
			this.clearTrackedTimer(state.processingTimer);
			state.processingTimer = null;
		}
		if (state) {
			state.processingTimeoutCallback = null;
		}
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	/** Cleanup — clears all processing timeouts. Safe to call multiple times. */
	dispose(): void {
		for (const [, state] of this.sessions) {
			if (state.processingTimer) {
				this.clearTrackedTimer(state.processingTimer);
			}
		}
		this.sessions.clear();
	}

	/** Cancel all tracked work (timers, promises) and dispose session state. */
	override async drain(): Promise<void> {
		this.dispose();
		await super.drain();
	}

	// ─── Backward-Compatible Shims ──────────────────────────────────────────
	// These delegate to a "_global" sentinel session so existing callers
	// keep working during the migration. Remove once all callers use the
	// per-session API (Tasks 5-14).

	/** @deprecated — use getModel(sessionId) */
	get model(): ModelOverride | undefined {
		return (
			this.sessions.get(SessionOverrides.GLOBAL)?.model ?? this.defaultModel
		);
	}

	/** @deprecated — use getAgent(sessionId) */
	get agent(): string | undefined {
		return this.sessions.get(SessionOverrides.GLOBAL)?.agent;
	}

	/** @deprecated — use isModelUserSelected(sessionId) */
	get modelUserSelected(): boolean {
		return (
			this.sessions.get(SessionOverrides.GLOBAL)?.modelUserSelected ?? false
		);
	}

	/** @deprecated — use getVariant(sessionId) */
	get variant(): string {
		return (
			this.sessions.get(SessionOverrides.GLOBAL)?.variant ?? this.defaultVariant
		);
	}
}
