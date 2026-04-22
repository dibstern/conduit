// ─── Compose Chat State Proxy Tests ──────────────────────────────────────────
// Asserts Proxy trap behavior: (a) get routes to the correct tier;
// (b) ownKeys iteration works; (c) `in` operator returns correct results;
// (d) set throws.

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
	ACTIVITY_KEYS,
	composeChatState,
	createEmptySessionActivity,
	createEmptySessionMessages,
	type SessionActivity,
	type SessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

function makeActivity(overrides?: Partial<SessionActivity>): SessionActivity {
	return { ...createEmptySessionActivity(), ...overrides };
}

function makeMessages(overrides?: Partial<SessionMessages>): SessionMessages {
	return { ...createEmptySessionMessages(), ...overrides };
}

describe("composeChatState Proxy", () => {
	describe("get trap", () => {
		it("routes activity keys to the activity tier", () => {
			const activity = makeActivity({ phase: "streaming", turnEpoch: 42 });
			const messages = makeMessages();
			const state = composeChatState(activity, messages);

			expect(state.phase).toBe("streaming");
			expect(state.turnEpoch).toBe(42);
			expect(state.currentMessageId).toBeNull();
		});

		it("routes messages keys to the messages tier", () => {
			const activity = makeActivity();
			const messages = makeMessages({
				currentAssistantText: "hello",
				contextPercent: 75,
				loadLifecycle: "ready",
			});
			const state = composeChatState(activity, messages);

			expect(state.currentAssistantText).toBe("hello");
			expect(state.contextPercent).toBe(75);
			expect(state.loadLifecycle).toBe("ready");
		});

		it("returns undefined for symbol keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			// biome-ignore lint/suspicious/noExplicitAny: intentional test cast
			expect((state as any)[Symbol("test")]).toBeUndefined();
		});
	});

	describe("set trap", () => {
		it("throws on any property assignment", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: intentional write for test
				(state as any).phase = "processing";
			}).toThrow("read-only");
		});

		it("throws with descriptive message", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			expect(() => {
				// biome-ignore lint/suspicious/noExplicitAny: intentional write for test
				(state as any).messages = [];
			}).toThrow(
				"currentChat() is read-only. Mutate state via handlers (activity, messages) parameters.",
			);
		});
	});

	describe("has trap (in operator)", () => {
		it("returns true for activity keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			expect("phase" in state).toBe(true);
			expect("turnEpoch" in state).toBe(true);
			expect("doneMessageIds" in state).toBe(true);
			expect("seenMessageIds" in state).toBe(true);
			expect("replayGeneration" in state).toBe(true);
		});

		it("returns true for messages keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			expect("messages" in state).toBe(true);
			expect("currentAssistantText" in state).toBe(true);
			expect("loadLifecycle" in state).toBe(true);
			expect("toolRegistry" in state).toBe(true);
		});

		it("returns false for unknown keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			expect("nonexistentProp" in state).toBe(false);
		});

		it("returns false for symbol keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			expect(Symbol("test") in state).toBe(false);
		});
	});

	describe("ownKeys trap", () => {
		it("returns all keys from both tiers", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			const keys = Object.keys(state);

			// Should include all activity keys
			for (const k of ACTIVITY_KEYS) {
				expect(keys).toContain(k);
			}

			// Should include all messages keys
			const messagesKeys = Object.keys(createEmptySessionMessages());
			for (const k of messagesKeys) {
				expect(keys).toContain(k);
			}
		});

		it("returns correct count (no duplicates)", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			const keys = Object.keys(state);
			const expected =
				ACTIVITY_KEYS.size + Object.keys(createEmptySessionMessages()).length;
			expect(keys.length).toBe(expected);
		});

		it("Object.entries iterates all fields", () => {
			const activity = makeActivity({ phase: "processing", turnEpoch: 5 });
			const messages = makeMessages({ contextPercent: 50 });
			const state = composeChatState(activity, messages);

			const entries = Object.entries(state);
			const entryMap = new Map(entries);

			expect(entryMap.get("phase")).toBe("processing");
			expect(entryMap.get("turnEpoch")).toBe(5);
			expect(entryMap.get("contextPercent")).toBe(50);
		});
	});

	describe("getOwnPropertyDescriptor trap", () => {
		it("returns descriptor for activity keys", () => {
			const activity = makeActivity({ phase: "streaming" });
			const state = composeChatState(activity, makeMessages());
			const desc = Object.getOwnPropertyDescriptor(state, "phase");
			expect(desc).toBeDefined();
			expect(desc?.value).toBe("streaming");
			expect(desc?.writable).toBe(false);
			expect(desc?.enumerable).toBe(true);
			expect(desc?.configurable).toBe(true);
		});

		it("returns descriptor for messages keys", () => {
			const messages = makeMessages({ contextPercent: 80 });
			const state = composeChatState(makeActivity(), messages);
			const desc = Object.getOwnPropertyDescriptor(state, "contextPercent");
			expect(desc).toBeDefined();
			expect(desc?.value).toBe(80);
		});

		it("returns undefined for unknown keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			const desc = Object.getOwnPropertyDescriptor(state, "unknownKey");
			expect(desc).toBeUndefined();
		});

		it("returns undefined for symbol keys", () => {
			const state = composeChatState(makeActivity(), makeMessages());
			const desc = Object.getOwnPropertyDescriptor(state, Symbol("test"));
			expect(desc).toBeUndefined();
		});
	});

	describe("spread / destructure", () => {
		it("spread produces a plain object with all keys", () => {
			const activity = makeActivity({ phase: "processing" });
			const messages = makeMessages({ contextPercent: 33 });
			const state = composeChatState(activity, messages);

			const spread = { ...state };
			expect(spread.phase).toBe("processing");
			expect(spread.contextPercent).toBe(33);
			expect(spread.messages).toEqual([]);
		});
	});
});
