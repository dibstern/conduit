// ─── The legacy chat mirror is frozen ───────────────────────────────────────
// `chatState` is a read-only view of the current session's slot
// (sessionActivity / sessionMessages). It has no storage of its own, nothing
// writes it, and it cannot be written. See ni8.5 §13 / conduit-test-ni8.5.17.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	chatState,
	getOrCreateSessionSlot,
	handleDelta,
	isProcessing,
	isReplaying,
	isStreaming,
	phaseStartReplay,
	phaseToStreaming,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

beforeEach(() => {
	sessionState.currentId = "session-a";
});

afterEach(() => {
	sessionActivity.clear();
	sessionMessages.clear();
	sessionState.currentId = null;
});

describe("chatState is read-only", () => {
	it("rejects a write to every mirrored field", () => {
		getOrCreateSessionSlot("session-a");
		expect(Object.isFrozen(chatState)).toBe(true);
		// Getter-only properties on a frozen object: assignment is a compile
		// error under `Readonly<…>` and a TypeError under strict mode.
		for (const patch of [
			{ phase: "streaming" },
			{ loadLifecycle: "ready" },
			{ messages: [] },
			{ currentAssistantText: "x" },
			{ turnEpoch: 7 },
			{ currentMessageId: "msg_1" },
		]) {
			expect(() => Object.assign(chatState, patch)).toThrow(TypeError);
		}
	});

	it("has no writer anywhere in src/", () => {
		const repoRoot = process.cwd();
		const assignment = /\bchatState\.[A-Za-z]+\s*(?:=[^=]|\+=|-=|\+\+|--)/;
		const hits = sourceFiles(join(repoRoot, "src")).flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					assignment.test(line)
						? [`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`]
						: [],
				),
		);
		expect(
			hits,
			"the chat mirror is derived; write the session slot instead",
		).toEqual([]);
	});
});

describe("chatState reflects the current session's slot", () => {
	it("follows currentId rather than the last writer", () => {
		const a = getOrCreateSessionSlot("session-a");
		const b = getOrCreateSessionSlot("session-b");
		phaseToStreaming(a.activity);
		a.messages.messages = [userMessage("from a")];
		b.messages.messages = [userMessage("from b")];

		expect(chatState.phase).toBe("streaming");
		expect(chatState.messages).toEqual(a.messages.messages);

		sessionState.currentId = "session-b";
		expect(chatState.phase).toBe("idle");
		expect(chatState.messages).toEqual(b.messages.messages);
	});

	it("is empty when no session is current", () => {
		getOrCreateSessionSlot("session-a");
		sessionState.currentId = null;
		expect(chatState.messages).toEqual([]);
		expect(chatState.phase).toBe("idle");
		expect(chatState.loadLifecycle).toBe("empty");
		expect(chatState.turnEpoch).toBe(0);
		expect(chatState.currentMessageId).toBeNull();
	});

	it("does not let a background session's delta reach the foreground", () => {
		const a = getOrCreateSessionSlot("session-a");
		a.messages.messages = [userMessage("from a")];
		const b = getOrCreateSessionSlot("session-b");

		handleDelta(b.activity, b.messages, {
			type: "delta",
			sessionId: "session-b",
			text: "background tokens",
			messageId: "msg_b",
			partId: "prt_b",
		});

		expect(chatState.messages).toEqual(a.messages.messages);
		expect(chatState.currentAssistantText).toBe("");
		expect(chatState.phase).toBe("idle");
	});
});

describe("phase flags read the current session's slot", () => {
	it("report the same values the slot holds", () => {
		const a = getOrCreateSessionSlot("session-a");
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
		expect(isReplaying()).toBe(false);

		phaseToStreaming(a.activity);
		expect(isProcessing()).toBe(true);
		expect(isStreaming()).toBe(true);

		phaseStartReplay(a.activity, a.messages);
		expect(isReplaying()).toBe(true);
		expect(isProcessing()).toBe(false);
		expect(isStreaming()).toBe(false);
	});

	it("ignore a background session's phase", () => {
		getOrCreateSessionSlot("session-a");
		const b = getOrCreateSessionSlot("session-b");
		phaseToStreaming(b.activity);
		expect(isStreaming()).toBe(false);
	});
});

function userMessage(text: string) {
	return {
		type: "user" as const,
		uuid: `uuid-${text}`,
		text,
		html: text,
		createdAt: 0,
		sentDuringEpoch: 0,
	};
}

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") || path.endsWith(".svelte") ? [path] : [];
	});
}
