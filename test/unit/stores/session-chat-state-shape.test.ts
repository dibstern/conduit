// The composite chat view must not have a field owned by both tiers.

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
	createEmptySessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";

describe("SessionChatState shape", () => {
	it("ACTIVITY_KEYS and SessionMessages keys are disjoint", () => {
		const activityKeys = new Set(ACTIVITY_KEYS);
		const messagesKeys = new Set(Object.keys(createEmptySessionMessages()));

		const overlap = [...activityKeys].filter((k) => messagesKeys.has(k));
		expect(overlap).toEqual([]);
	});
});
