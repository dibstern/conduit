// ─── Empty State Frozen Tests ────────────────────────────────────────────────
// Asserts EMPTY_STATE mutations throw; EMPTY_MESSAGES.toolRegistry method
// calls throw (methods stubbed with throwing stubs).

import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	let store: Record<string, string> = {};
	const mock = {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
		get length() {
			return Object.keys(store).length;
		},
		key: vi.fn((_: number) => null),
	};
	Object.defineProperty(globalThis, "localStorage", {
		value: mock,
		writable: true,
		configurable: true,
	});
});

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	EMPTY_ACTIVITY,
	EMPTY_MESSAGES,
	EMPTY_STATE,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("EMPTY_ACTIVITY", () => {
	it("is frozen", () => {
		expect(Object.isFrozen(EMPTY_ACTIVITY)).toBe(true);
	});

	it("throws on direct property mutation", () => {
		expect(() => {
			// biome-ignore lint/suspicious/noExplicitAny: intentional write for test
			(EMPTY_ACTIVITY as any).phase = "processing";
		}).toThrow();
	});

	it("has default idle values", () => {
		expect(EMPTY_ACTIVITY.phase).toBe("idle");
		expect(EMPTY_ACTIVITY.turnEpoch).toBe(0);
		expect(EMPTY_ACTIVITY.currentMessageId).toBeNull();
		expect(EMPTY_ACTIVITY.replayGeneration).toBe(0);
	});
});

describe("EMPTY_MESSAGES", () => {
	it("is frozen", () => {
		expect(Object.isFrozen(EMPTY_MESSAGES)).toBe(true);
	});

	it("throws on direct property mutation", () => {
		expect(() => {
			// biome-ignore lint/suspicious/noExplicitAny: intentional write for test
			(EMPTY_MESSAGES as any).messages = [{ type: "user" }];
		}).toThrow();
	});

	it("has default empty values", () => {
		expect(EMPTY_MESSAGES.messages).toEqual([]);
		expect(EMPTY_MESSAGES.currentAssistantText).toBe("");
		expect(EMPTY_MESSAGES.loadLifecycle).toBe("empty");
		expect(EMPTY_MESSAGES.contextPercent).toBe(0);
	});

	it("toolRegistry.start throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.start("id", "name")).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});

	it("toolRegistry.executing throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.executing("id")).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});

	it("toolRegistry.complete throws", () => {
		expect(() =>
			EMPTY_MESSAGES.toolRegistry.complete("id", "content", false),
		).toThrow("EMPTY_MESSAGES.toolRegistry is read-only");
	});

	it("toolRegistry.finalizeAll throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.finalizeAll([])).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});

	it("toolRegistry.clear throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.clear()).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});

	it("toolRegistry.remove throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.remove("id")).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});

	it("toolRegistry.getUuid throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.getUuid("id")).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});

	it("toolRegistry.seedFromHistory throws", () => {
		expect(() => EMPTY_MESSAGES.toolRegistry.seedFromHistory([])).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});
});

describe("EMPTY_STATE (composeChatState-wrapped)", () => {
	it("reads from frozen activity tier", () => {
		expect(EMPTY_STATE.phase).toBe("idle");
		expect(EMPTY_STATE.turnEpoch).toBe(0);
		expect(EMPTY_STATE.currentMessageId).toBeNull();
	});

	it("reads from frozen messages tier", () => {
		expect(EMPTY_STATE.messages).toEqual([]);
		expect(EMPTY_STATE.currentAssistantText).toBe("");
		expect(EMPTY_STATE.loadLifecycle).toBe("empty");
	});

	it("set trap throws on property assignment", () => {
		expect(() => {
			// biome-ignore lint/suspicious/noExplicitAny: intentional write for test
			(EMPTY_STATE as any).phase = "processing";
		}).toThrow();
	});

	it("has operator works", () => {
		expect("phase" in EMPTY_STATE).toBe(true);
		expect("messages" in EMPTY_STATE).toBe(true);
		expect("nonexistent" in EMPTY_STATE).toBe(false);
	});

	it("Object.keys returns all keys", () => {
		const keys = Object.keys(EMPTY_STATE);
		expect(keys).toContain("phase");
		expect(keys).toContain("messages");
		expect(keys).toContain("toolRegistry");
		expect(keys.length).toBeGreaterThan(0);
	});

	it("toolRegistry methods from EMPTY_STATE throw", () => {
		expect(() => EMPTY_STATE.toolRegistry.start("id", "name")).toThrow(
			"EMPTY_MESSAGES.toolRegistry is read-only",
		);
	});
});
