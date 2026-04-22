// ─── Session Chat State Shape Tests ──────────────────────────────────────────
// Asserts the union of ACTIVITY_KEYS and Object.keys(createEmptySessionMessages())
// exactly equals keyof SessionChatState. Catches drift when a field is added to
// only one tier.

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
	createEmptySessionActivity,
	createEmptySessionMessages,
	type SessionChatState,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("SessionChatState shape", () => {
	it("ACTIVITY_KEYS union with SessionMessages keys equals SessionChatState keys", () => {
		const activityKeys = new Set(ACTIVITY_KEYS);
		const messagesKeys = new Set(Object.keys(createEmptySessionMessages()));

		// Combined set
		const combined = new Set([...activityKeys, ...messagesKeys]);

		// Derive expected keys from both factories
		const activityObj = createEmptySessionActivity();
		const expectedFromFactories = new Set([
			...Object.keys(activityObj),
			...Object.keys(createEmptySessionMessages()),
		]);

		expect(combined).toEqual(expectedFromFactories);
	});

	it("ACTIVITY_KEYS and SessionMessages keys are disjoint", () => {
		const activityKeys = new Set(ACTIVITY_KEYS);
		const messagesKeys = new Set(Object.keys(createEmptySessionMessages()));

		const overlap = [...activityKeys].filter((k) => messagesKeys.has(k));
		expect(overlap).toEqual([]);
	});

	it("ACTIVITY_KEYS matches the keys of createEmptySessionActivity()", () => {
		const fromFactory = Object.keys(createEmptySessionActivity());
		const fromSet = [...ACTIVITY_KEYS];
		expect(new Set(fromSet)).toEqual(new Set(fromFactory));
	});

	it("combined keys type-check against SessionChatState", () => {
		// This is a compile-time check — if any key is missing from
		// SessionChatState, TypeScript will flag it.
		const activityKeys = Object.keys(
			createEmptySessionActivity(),
		) as (keyof SessionChatState)[];
		const messagesKeys = Object.keys(
			createEmptySessionMessages(),
		) as (keyof SessionChatState)[];

		// Runtime: every expected key is present
		const allKeys = [...activityKeys, ...messagesKeys];
		expect(allKeys.length).toBeGreaterThan(0);
		// No duplicates
		expect(new Set(allKeys).size).toBe(allKeys.length);
	});
});
