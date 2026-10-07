import {
	seedFamilySessions,
	seedRootSessions,
	seedSessions,
} from "./session-fixtures.js";
// Family attention follows shell and family rows.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must mock localStorage BEFORE any store modules are loaded.
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

// Mock DOMPurify (browser-only) before importing stores
vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	clearMessages,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { clearAllPermissions } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import {
	clearSessionState,
	getAttentionSessions,
	getSessionIndicator,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";

beforeEach(() => {
	clearMessages();
	clearAllPermissions();
	clearSessionState();
	seedRootSessions(
		["session-a", "session-b", "session-c"].map((id) => ({ id, title: "" })),
	);
	seedFamilySessions([]);
	sessionState.currentId = "session-a";
	seedSessions([
		...sessionState.sessions.values(),
		...["session-a", "session-b", "session-c"].map((id) => ({
			id,
			title: "",
			status: "idle" as const,
		})),
	]);
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	clearMessages();
	sessionActivity.clear();
	sessionMessages.clear();
	clearSessionState();
});

describe("family attention before membership", () => {
	it("roots-only reconciliation preserves child indicators and uses rolled root counts", () => {
		seedFamilySessions([
			{ id: "root", title: "Root" },
			{
				id: "new-child",
				title: "Child",
				parentID: "root",
				pendingQuestionCount: 1,
			},
		]);
		seedSessions([
			{
				id: "root",
				title: "Root",
				status: "idle",
				pendingPermissionCount: 2,
				pendingQuestionCount: 1,
			},
		]);
		expect(getSessionIndicator("new-child", null)).toBe("attention");
		expect(getAttentionSessions(null, () => new Set()).get("root")).toEqual({
			questions: 1,
			permissions: 2,
		});
	});
});
