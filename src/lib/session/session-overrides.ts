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
	setModel(sessionId: string, model: ModelOverride): void {
		const s = this.getOrCreate(sessionId);
		s.model = model;
		s.modelUserSelected = true;
	}

	/** Set model for display WITHOUT marking as user-selected (auto-detected). */
	setModelDefault(sessionId: string, model: ModelOverride): void {
		const s = this.getOrCreate(sessionId);
		s.model = model;
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
	setAgent(sessionId: string, agentId: string): void {
		this.getOrCreate(sessionId).agent = agentId;
	}

	/** Get the agent override for a session. */
	getAgent(sessionId: string): string | undefined {
		return this.sessions.get(sessionId)?.agent;
	}

	// ─── Per-Session Variant (Thinking Level) ───────────────────────────────

	/** Set the variant (thinking level) for a session. Empty string clears. */
	setVariant(sessionId: string, variant: string): void {
		this.getOrCreate(sessionId).variant = variant;
	}

	/** Get the variant for a session (per-session override ?? global default). */
	getVariant(sessionId: string): string {
		return this.sessions.get(sessionId)?.variant ?? this.defaultVariant;
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
	startProcessingTimeout(sessionId: string, onTimeout: () => void): void {
		const s = this.getOrCreate(sessionId);
		if (s.processingTimer) {
			this.clearTrackedTimer(s.processingTimer);
		}
		s.processingTimeoutCallback = onTimeout;
		s.processingTimer = this.delayed(() => {
			s.processingTimer = null;
			s.processingTimeoutCallback = null;
			onTimeout();
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
	clearProcessingTimeout(sessionId: string): void {
		const state = this.sessions.get(sessionId);
		if (state?.processingTimer) {
			this.clearTrackedTimer(state.processingTimer);
			state.processingTimer = null;
		}
		if (state) {
			state.processingTimeoutCallback = null;
		}
	}

	/** Check if a session has an active processing timeout (Claude turn in progress). */
	hasActiveProcessingTimeout(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.processingTimer != null;
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
}
