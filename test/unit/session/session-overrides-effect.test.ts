// ─── Session Overrides Effect Tests ─────────────────────────────────────────
// Tests for the Effect-native SessionOverrides replacement using
// Ref<OverridesState> + Fiber timeout management.

import { describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Ref, TestClock } from "effect";
import { expect } from "vitest";
import {
	clearProcessingTimeout,
	clearSession,
	getAgent,
	getContextWindow,
	getModel,
	getVariant,
	hasActiveProcessingTimeout,
	isModelUserSelected,
	makeOverridesStateLive,
	OverridesStateTag,
	resetProcessingTimeout,
	setAgent,
	setContextWindow,
	setDefaultContextWindow,
	setDefaultModel,
	setDefaultVariant,
	setModel,
	setModelDefault,
	setVariant,
	startProcessingTimeout,
} from "../../../src/lib/effect/session-overrides-state.js";

const TIMEOUT_MS = 120_000;

describe("SessionOverrides Effect", () => {
	// ─── Per-Session Model ──────────────────────────────────────────────────

	it.effect("setModel stores model and marks userSelected", () =>
		Effect.gen(function* () {
			yield* setModel("sess-1", {
				providerID: "anthropic",
				modelID: "claude-4",
			});
			const model = yield* getModel("sess-1");
			const selected = yield* isModelUserSelected("sess-1");

			expect(model).toEqual({
				providerID: "anthropic",
				modelID: "claude-4",
			});
			expect(selected).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("setModelDefault stores model without changing userSelected", () =>
		Effect.gen(function* () {
			yield* setModelDefault("sess-1", {
				providerID: "anthropic",
				modelID: "claude-4",
			});
			const model = yield* getModel("sess-1");
			const selected = yield* isModelUserSelected("sess-1");

			expect(model?.modelID).toBe("claude-4");
			expect(selected).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("setModelDefault preserves existing userSelected flag", () =>
		Effect.gen(function* () {
			yield* setModel("sess-1", {
				providerID: "anthropic",
				modelID: "claude-4",
			});
			expect(yield* isModelUserSelected("sess-1")).toBe(true);

			yield* setModelDefault("sess-1", {
				providerID: "openai",
				modelID: "gpt-5",
			});
			expect((yield* getModel("sess-1"))?.modelID).toBe("gpt-5");
			expect(yield* isModelUserSelected("sess-1")).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect(
		"getModel returns per-session model or falls back to defaultModel",
		() =>
			Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "anthropic",
					modelID: "claude-4",
				});

				// No per-session model — returns default
				expect((yield* getModel("sess-1"))?.modelID).toBe("claude-4");

				// Per-session model takes priority
				yield* setModel("sess-1", {
					providerID: "openai",
					modelID: "gpt-5",
				});
				expect((yield* getModel("sess-1"))?.modelID).toBe("gpt-5");

				// Other sessions still get default
				expect((yield* getModel("sess-2"))?.modelID).toBe("claude-4");
			}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect(
		"getModel returns undefined when no default and no per-session",
		() =>
			Effect.gen(function* () {
				const model = yield* getModel("unknown");
				expect(model).toBeUndefined();
			}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("isModelUserSelected returns false for unknown session", () =>
		Effect.gen(function* () {
			expect(yield* isModelUserSelected("unknown")).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	// ─── Per-Session Agent ──────────────────────────────────────────────────

	it.effect("setAgent/getAgent stores and retrieves agent", () =>
		Effect.gen(function* () {
			yield* setAgent("sess-1", "code");
			expect(yield* getAgent("sess-1")).toBe("code");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("different sessions have independent agents", () =>
		Effect.gen(function* () {
			yield* setAgent("sess-1", "code");
			yield* setAgent("sess-2", "plan");
			expect(yield* getAgent("sess-1")).toBe("code");
			expect(yield* getAgent("sess-2")).toBe("plan");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("getAgent returns undefined for unknown session", () =>
		Effect.gen(function* () {
			expect(yield* getAgent("unknown")).toBeUndefined();
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	// ─── Per-Session Variant ────────────────────────────────────────────────

	it.effect("setVariant/getVariant with fallback to defaultVariant", () =>
		Effect.gen(function* () {
			yield* setDefaultVariant("low");

			// Falls back to defaultVariant
			expect(yield* getVariant("sess-1")).toBe("low");

			// Per-session takes precedence
			yield* setVariant("sess-1", "max");
			expect(yield* getVariant("sess-1")).toBe("max");

			// Other sessions still get default
			expect(yield* getVariant("sess-2")).toBe("low");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("getVariant returns empty string by default", () =>
		Effect.gen(function* () {
			expect(yield* getVariant("sess-1")).toBe("");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("setting empty string clears variant", () =>
		Effect.gen(function* () {
			yield* setVariant("sess-1", "high");
			yield* setVariant("sess-1", "");
			expect(yield* getVariant("sess-1")).toBe("");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	// ─── Per-Session Context Window ─────────────────────────────────────────

	it.effect(
		"setContextWindow/getContextWindow with fallback to defaultContextWindow",
		() =>
			Effect.gen(function* () {
				yield* setDefaultContextWindow("200k");

				// Falls back to defaultContextWindow
				expect(yield* getContextWindow("sess-1")).toBe("200k");

				// Per-session takes precedence
				yield* setContextWindow("sess-1", "1m");
				expect(yield* getContextWindow("sess-1")).toBe("1m");

				// Other sessions still get default
				expect(yield* getContextWindow("sess-2")).toBe("200k");
			}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("getContextWindow returns empty string by default", () =>
		Effect.gen(function* () {
			expect(yield* getContextWindow("sess-1")).toBe("");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("setting empty string clears context window", () =>
		Effect.gen(function* () {
			yield* setContextWindow("sess-1", "1m");
			yield* setContextWindow("sess-1", "");
			expect(yield* getContextWindow("sess-1")).toBe("");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	// ─── Clear Session ──────────────────────────────────────────────────────

	it.scoped("clearSession removes all overrides and interrupts timeout", () =>
		Effect.gen(function* () {
			yield* setAgent("sess-1", "code");
			yield* setModel("sess-1", {
				providerID: "anthropic",
				modelID: "claude-4",
			});

			const called = { value: false };
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					called.value = true;
				}),
			);

			yield* clearSession("sess-1");

			// Agent and model cleared
			expect(yield* getAgent("sess-1")).toBeUndefined();
			expect(yield* isModelUserSelected("sess-1")).toBe(false);

			// Timeout fiber was interrupted — callback should not fire
			yield* TestClock.adjust(Duration.millis(TIMEOUT_MS + 1000));
			expect(called.value).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("clearSession with defaultModel — getModel falls back", () =>
		Effect.gen(function* () {
			yield* setDefaultModel({
				providerID: "anthropic",
				modelID: "claude-4",
			});
			yield* setModel("sess-1", {
				providerID: "openai",
				modelID: "gpt-5",
			});
			yield* clearSession("sess-1");
			expect((yield* getModel("sess-1"))?.modelID).toBe("claude-4");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("clearSession is safe for unknown session", () =>
		Effect.gen(function* () {
			yield* clearSession("unknown"); // should not throw
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.effect("clearSession does not affect other sessions", () =>
		Effect.gen(function* () {
			yield* setModel("sess-1", {
				providerID: "anthropic",
				modelID: "claude-4",
			});
			yield* setModel("sess-2", {
				providerID: "openai",
				modelID: "gpt-5",
			});
			yield* clearSession("sess-1");
			expect((yield* getModel("sess-2"))?.modelID).toBe("gpt-5");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	// ─── Processing Timeout ─────────────────────────────────────────────────

	it.scoped("processing timeout fires after duration", () =>
		Effect.gen(function* () {
			const called = { value: false };
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					called.value = true;
				}),
			);

			// Not yet
			yield* TestClock.adjust(Duration.millis(TIMEOUT_MS - 1));
			expect(called.value).toBe(false);

			// Fire
			yield* TestClock.adjust(Duration.millis(2));
			expect(called.value).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("restarting timeout cancels previous", () =>
		Effect.gen(function* () {
			const cb1Called = { value: false };
			const cb2Called = { value: false };
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					cb1Called.value = true;
				}),
			);

			// Replace with new timeout
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					cb2Called.value = true;
				}),
			);

			yield* TestClock.adjust(Duration.millis(TIMEOUT_MS + 1));
			expect(cb1Called.value).toBe(false);
			expect(cb2Called.value).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("clearProcessingTimeout stops active timeout", () =>
		Effect.gen(function* () {
			const called = { value: false };
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					called.value = true;
				}),
			);

			yield* clearProcessingTimeout("sess-1");
			yield* TestClock.adjust(Duration.millis(TIMEOUT_MS + 1000));
			expect(called.value).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("hasActiveProcessingTimeout returns correct state", () =>
		Effect.gen(function* () {
			expect(yield* hasActiveProcessingTimeout("sess-1")).toBe(false);

			yield* startProcessingTimeout(
				"sess-1",
				Duration.millis(TIMEOUT_MS),
				() => Effect.void,
			);
			expect(yield* hasActiveProcessingTimeout("sess-1")).toBe(true);

			yield* clearProcessingTimeout("sess-1");
			expect(yield* hasActiveProcessingTimeout("sess-1")).toBe(false);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("clearProcessingTimeout is safe when no timer is active", () =>
		Effect.gen(function* () {
			yield* clearProcessingTimeout("sess-1"); // should not throw
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("clearProcessingTimeout is safe for unknown session", () =>
		Effect.gen(function* () {
			yield* clearProcessingTimeout("unknown"); // should not throw
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("resetProcessingTimeout restarts with same callback", () =>
		Effect.gen(function* () {
			const called = { value: false };
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					called.value = true;
				}),
			);

			// Advance 100s
			yield* TestClock.adjust(Duration.millis(100_000));
			expect(called.value).toBe(false);

			// Reset — timer restarts from 120s
			yield* resetProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS));

			// Advance another 100s (would have fired without reset)
			yield* TestClock.adjust(Duration.millis(100_000));
			expect(called.value).toBe(false);

			// Advance to the new 120s mark
			yield* TestClock.adjust(Duration.millis(20_001));
			expect(called.value).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("resetProcessingTimeout is no-op when no timer active", () =>
		Effect.gen(function* () {
			// Should not throw
			yield* resetProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS));
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	it.scoped("two sessions have independent timeouts", () =>
		Effect.gen(function* () {
			const cb1Called = { value: false };
			const cb2Called = { value: false };
			yield* startProcessingTimeout("sess-1", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					cb1Called.value = true;
				}),
			);
			yield* startProcessingTimeout("sess-2", Duration.millis(TIMEOUT_MS), () =>
				Effect.sync(() => {
					cb2Called.value = true;
				}),
			);

			yield* clearProcessingTimeout("sess-1");
			yield* TestClock.adjust(Duration.millis(TIMEOUT_MS + 1));

			expect(cb1Called.value).toBe(false);
			expect(cb2Called.value).toBe(true);
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);

	// ─── Layer isolation ────────────────────────────────────────────────────

	it.effect("Layer.fresh provides isolated state per test", () =>
		Effect.gen(function* () {
			const ref = yield* OverridesStateTag;
			const state = yield* Ref.get(ref);
			expect(state.sessions.size).toBe(0);
			expect(state.defaultModel).toBeUndefined();
			expect(state.defaultVariant).toBe("");
		}).pipe(Effect.provide(Layer.fresh(makeOverridesStateLive()))),
	);
});
