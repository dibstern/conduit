// ─── SessionOverrides Tests ─────────────────────────────────────────────────
// Tests for per-session overrides: model/agent management, default model,
// per-session processing timeout, clearSession/dispose lifecycle.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { SessionOverrides } from "../../../src/lib/session/session-overrides.js";

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

// ─── Initial State ──────────────────────────────────────────────────────────

describe("SessionOverrides — initial state", () => {
	it("defaultModel is undefined initially", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		expect(overrides.defaultModel).toBeUndefined();
	});

	it("getModel returns undefined for unknown session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		expect(overrides.getModel("unknown")).toBeUndefined();
	});

	it("getAgent returns undefined for unknown session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		expect(overrides.getAgent("unknown")).toBeUndefined();
	});

	it("isModelUserSelected returns false for unknown session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		expect(overrides.isModelUserSelected("unknown")).toBe(false);
	});
});

// ─── Default Model ──────────────────────────────────────────────────────────

describe("SessionOverrides — defaultModel", () => {
	it("setDefaultModel stores the default", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setDefaultModel({ providerID: "anthropic", modelID: "claude-4" });
		expect(overrides.defaultModel).toEqual({
			providerID: "anthropic",
			modelID: "claude-4",
		});
	});

	it("getModel returns defaultModel for sessions with no per-session override", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setDefaultModel({ providerID: "anthropic", modelID: "claude-4" });
		expect(overrides.getModel("any-session")).toEqual({
			providerID: "anthropic",
			modelID: "claude-4",
		});
	});

	it("per-session model takes priority over defaultModel", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setDefaultModel({ providerID: "anthropic", modelID: "claude-4" });
		overrides.setModel("sess-1", { providerID: "openai", modelID: "gpt-5" });
		expect(overrides.getModel("sess-1")?.modelID).toBe("gpt-5");
	});

	it("clearSession restores to defaultModel", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setDefaultModel({ providerID: "anthropic", modelID: "claude-4" });
		overrides.setModel("sess-1", { providerID: "openai", modelID: "gpt-5" });
		overrides.clearSession("sess-1");
		expect(overrides.getModel("sess-1")?.modelID).toBe("claude-4");
	});

	it("clearSession with no defaultModel returns undefined for getModel", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModel("sess-1", { providerID: "openai", modelID: "gpt-5" });
		overrides.clearSession("sess-1");
		expect(overrides.getModel("sess-1")).toBeUndefined();
	});
});

// ─── Per-Session Agent ──────────────────────────────────────────────────────

describe("SessionOverrides — per-session agent", () => {
	it("sets agent for a specific session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setAgent("sess-1", "code");
		expect(overrides.getAgent("sess-1")).toBe("code");
	});

	it("different sessions have independent agents", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setAgent("sess-1", "code");
		overrides.setAgent("sess-2", "plan");
		expect(overrides.getAgent("sess-1")).toBe("code");
		expect(overrides.getAgent("sess-2")).toBe("plan");
	});

	it("overwrites a previous agent for the same session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setAgent("sess-1", "code");
		overrides.setAgent("sess-1", "plan");
		expect(overrides.getAgent("sess-1")).toBe("plan");
	});
});

// ─── Per-Session Model ──────────────────────────────────────────────────────

describe("SessionOverrides — per-session model", () => {
	it("setModel sets model and marks modelUserSelected for that session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModel("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		expect(overrides.getModel("sess-1")).toEqual({
			providerID: "anthropic",
			modelID: "claude-4",
		});
		expect(overrides.isModelUserSelected("sess-1")).toBe(true);
	});

	it("different sessions have independent models", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModel("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		overrides.setModel("sess-2", { providerID: "openai", modelID: "gpt-5" });
		expect(overrides.getModel("sess-1")?.modelID).toBe("claude-4");
		expect(overrides.getModel("sess-2")?.modelID).toBe("gpt-5");
	});

	it("setModelDefault sets model WITHOUT marking modelUserSelected", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModelDefault("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		expect(overrides.getModel("sess-1")?.modelID).toBe("claude-4");
		expect(overrides.isModelUserSelected("sess-1")).toBe(false);
	});

	it("setModelDefault does not clear existing modelUserSelected flag", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModel("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		expect(overrides.isModelUserSelected("sess-1")).toBe(true);
		overrides.setModelDefault("sess-1", {
			providerID: "openai",
			modelID: "gpt-5",
		});
		expect(overrides.getModel("sess-1")?.modelID).toBe("gpt-5");
		expect(overrides.isModelUserSelected("sess-1")).toBe(true);
	});

	it("isModelUserSelected is false for sessions with only setModelDefault", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModelDefault("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		expect(overrides.isModelUserSelected("sess-1")).toBe(false);
	});
});

// ─── clearSession ───────────────────────────────────────────────────────────

describe("SessionOverrides — clearSession", () => {
	it("clears model, agent, and modelUserSelected for the session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setAgent("sess-1", "code");
		overrides.setModel("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		overrides.clearSession("sess-1");
		expect(overrides.getAgent("sess-1")).toBeUndefined();
		expect(overrides.isModelUserSelected("sess-1")).toBe(false);
	});

	it("does not affect other sessions", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setModel("sess-1", {
			providerID: "anthropic",
			modelID: "claude-4",
		});
		overrides.setModel("sess-2", { providerID: "openai", modelID: "gpt-5" });
		overrides.clearSession("sess-1");
		expect(overrides.getModel("sess-2")?.modelID).toBe("gpt-5");
	});

	it("clears the processing timeout for that session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const callback = vi.fn();
		overrides.startProcessingTimeout("sess-1", callback);
		overrides.clearSession("sess-1");
		vi.advanceTimersByTime(200_000);
		expect(callback).not.toHaveBeenCalled();
	});

	it("is safe to call for unknown session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.clearSession("unknown"); // should not throw
	});
});

// ─── Per-Session Processing Timeout ─────────────────────────────────────────

describe("SessionOverrides — per-session processing timeout", () => {
	it("calls callback after 120s for the specific session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const callback = vi.fn();
		overrides.startProcessingTimeout("sess-1", callback);

		vi.advanceTimersByTime(119_999);
		expect(callback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(2);
		expect(callback).toHaveBeenCalledOnce();
	});

	it("two sessions have independent timeouts", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		overrides.startProcessingTimeout("sess-1", cb1);
		overrides.startProcessingTimeout("sess-2", cb2);

		overrides.clearProcessingTimeout("sess-1");
		vi.advanceTimersByTime(120_001);

		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).toHaveBeenCalledOnce();
	});

	it("clearProcessingTimeout prevents callback from firing", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const callback = vi.fn();
		overrides.startProcessingTimeout("sess-1", callback);
		overrides.clearProcessingTimeout("sess-1");

		vi.advanceTimersByTime(200_000);
		expect(callback).not.toHaveBeenCalled();
	});

	it("startProcessingTimeout cancels a previous timeout for the same session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		overrides.startProcessingTimeout("sess-1", cb1);
		overrides.startProcessingTimeout("sess-1", cb2);

		vi.advanceTimersByTime(120_001);
		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).toHaveBeenCalledOnce();
	});

	it("clearProcessingTimeout is safe when no timer is active", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.clearProcessingTimeout("sess-1"); // should not throw
	});

	it("clearProcessingTimeout is safe for unknown session", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.clearProcessingTimeout("unknown"); // should not throw
	});
});

// ─── dispose ────────────────────────────────────────────────────────────────

describe("SessionOverrides — resetProcessingTimeout", () => {
	it("resets the timer back to 120s with the same callback", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const callback = vi.fn();
		overrides.startProcessingTimeout("sess-1", callback);

		// Advance 100s (timer at 20s remaining)
		vi.advanceTimersByTime(100_000);
		expect(callback).not.toHaveBeenCalled();

		// Reset — timer should start over from 120s
		overrides.resetProcessingTimeout("sess-1");

		// Advance another 100s (would have fired at 120s without reset)
		vi.advanceTimersByTime(100_000);
		expect(callback).not.toHaveBeenCalled();

		// Advance to the new 120s mark
		vi.advanceTimersByTime(20_001);
		expect(callback).toHaveBeenCalledOnce();
	});

	it("is a no-op when no timer is active", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		// Should not throw
		overrides.resetProcessingTimeout("sess-1");
	});

	it("is a no-op for unknown sessions", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.startProcessingTimeout("sess-1", vi.fn());
		// Resetting a different session should not affect sess-1
		overrides.resetProcessingTimeout("unknown");
		vi.advanceTimersByTime(120_001);
	});

	it("does not affect other sessions' timers", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		overrides.startProcessingTimeout("sess-1", cb1);
		overrides.startProcessingTimeout("sess-2", cb2);

		// Advance 100s
		vi.advanceTimersByTime(100_000);

		// Reset only sess-1
		overrides.resetProcessingTimeout("sess-1");

		// Advance 20s more — sess-2's 120s fires, sess-1's reset timer still has 100s
		vi.advanceTimersByTime(20_001);
		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).toHaveBeenCalledOnce();

		// Advance to sess-1's new 120s mark
		vi.advanceTimersByTime(100_000);
		expect(cb1).toHaveBeenCalledOnce();
	});

	it("is a no-op after clearProcessingTimeout", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const callback = vi.fn();
		overrides.startProcessingTimeout("sess-1", callback);
		overrides.clearProcessingTimeout("sess-1");

		// Reset should be a no-op since timer was cleared
		overrides.resetProcessingTimeout("sess-1");

		vi.advanceTimersByTime(200_000);
		expect(callback).not.toHaveBeenCalled();
	});
});

// ─── dispose ────────────────────────────────────────────────────────────────

describe("SessionOverrides — dispose", () => {
	it("clears all processing timeouts across all sessions", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		overrides.startProcessingTimeout("sess-1", cb1);
		overrides.startProcessingTimeout("sess-2", cb2);
		overrides.dispose();

		vi.advanceTimersByTime(200_000);
		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).not.toHaveBeenCalled();
	});

	it("is safe to call multiple times", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.dispose();
		overrides.dispose();
	});
});

// ─── Variant (thinking level) ───────────────────────────────────────────────

describe("SessionOverrides — variant", () => {
	it("defaults to empty string", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		expect(overrides.variant).toBe("");
		expect(overrides.defaultVariant).toBe("");
	});

	it("setVariant(sessionId, variant) sets per-session variant", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setVariant("sess-1", "high");
		expect(overrides.getVariant("sess-1")).toBe("high");
	});

	it("setVariant(variant) sets global default variant", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setVariant("medium");
		expect(overrides.variant).toBe("medium");
		expect(overrides.defaultVariant).toBe("medium");
	});

	it("getVariant falls back to defaultVariant when session has no override", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.defaultVariant = "low";
		expect(overrides.getVariant("sess-new")).toBe("low");
	});

	it("per-session variant takes precedence over defaultVariant", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.defaultVariant = "low";
		overrides.setVariant("sess-1", "max");
		expect(overrides.getVariant("sess-1")).toBe("max");
	});

	it("clearSession removes per-session variant", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setVariant("sess-1", "high");
		overrides.clearSession("sess-1");
		expect(overrides.getVariant("sess-1")).toBe("");
	});

	it("setting empty string clears variant", () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setVariant("sess-1", "high");
		overrides.setVariant("sess-1", "");
		expect(overrides.getVariant("sess-1")).toBe("");
	});
});

// ─── drain ──────────────────────────────────────────────────────────────────

describe("SessionOverrides — drain", () => {
	it("clears all processing timeouts via drain()", async () => {
		const registry = new ServiceRegistry();
		const overrides = new SessionOverrides(registry);
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		const cb3 = vi.fn();
		overrides.startProcessingTimeout("sess-1", cb1);
		overrides.startProcessingTimeout("sess-2", cb2);
		overrides.startProcessingTimeout("sess-3", cb3);

		await overrides.drain();

		vi.advanceTimersByTime(200_000);
		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).not.toHaveBeenCalled();
		expect(cb3).not.toHaveBeenCalled();
	});

	it("drainAll on registry clears all SessionOverrides timeouts", async () => {
		const registry = new ServiceRegistry();
		const overrides = new SessionOverrides(registry);
		const cb1 = vi.fn();
		const cb2 = vi.fn();
		overrides.startProcessingTimeout("sess-1", cb1);
		overrides.startProcessingTimeout("sess-2", cb2);

		await registry.drainAll();

		vi.advanceTimersByTime(200_000);
		expect(cb1).not.toHaveBeenCalled();
		expect(cb2).not.toHaveBeenCalled();
	});

	it("registers itself in the ServiceRegistry on construction", () => {
		const registry = new ServiceRegistry();
		expect(registry.size).toBe(0);
		new SessionOverrides(registry);
		expect(registry.size).toBe(1);
	});
});
