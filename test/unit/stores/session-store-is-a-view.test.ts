// @vitest-environment jsdom
// ─── The session store is a view ─────────────────────────────────────────────
// The authoritative map lives with the subscription that fills it. The store
// reads it; it does not hold a copy. These tests hold that line from both
// sides: a change pushed straight into the subscription shows up through the
// store's read API, and a change pushed through the store's `apply*` door shows
// up in the subscription — because there is only one map to show up in.
//
// They also hold the vocabulary line. The store's API says `sessions`,
// `findSession`, `getFilteredSessions`; the words snapshot, upsert, remove,
// synchronized and sequence belong to the transport and stop there.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeSessionTitle } from "./session-view-consumer.svelte.js";

vi.hoisted(() => {
	let store: Record<string, string> = {};
	Object.defineProperty(globalThis, "localStorage", {
		value: {
			getItem: (k: string) => store[k] ?? null,
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
			removeItem: (k: string) => {
				delete store[k];
			},
			clear: () => {
				store = {};
			},
			get length() {
				return Object.keys(store).length;
			},
			key: () => null,
		},
		writable: true,
		configurable: true,
	});
});

vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));

import {
	applySessionRemoved,
	applySessionSnapshot,
	applySessionUpsert,
	clearSessionState,
	findSession,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import {
	applySessionChange,
	type ShellEnvelope,
	sessionSubscription,
} from "../../../src/lib/frontend/transport/session-subscription.svelte.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

const session = (id: string, title = id): SessionInfo => ({
	id,
	title,
	status: "idle",
});

const ids = (): readonly string[] => [...sessionState.sessions.keys()].sort();

beforeEach(() => {
	clearSessionState();
});

describe("the session store", () => {
	it("exposes whether its rows are settled and clears that view on project change", () => {
		expect(sessionState.settled).toBe(false);
		applySessionChange({
			_tag: "snapshot",
			rows: [session("s1")],
			sequence: 1,
		});
		expect(sessionState.settled).toBe(false);
		applySessionChange({ _tag: "synchronized" });
		expect(sessionState.settled).toBe(true);
		clearSessionState();
		expect(sessionState.settled).toBe(false);
	});

	it("reads the map the subscription owns", () => {
		applySessionChange({
			_tag: "snapshot",
			rows: [session("s1"), session("s2")],
			sequence: 5,
		});

		expect(ids()).toEqual(["s1", "s2"]);
		expect(findSession("s1")?.title).toBe("s1");
	});

	it("hands the same map back, not a copy taken at read time", () => {
		applySessionChange({ _tag: "upsert", item: session("s1"), sequence: 1 });
		expect(sessionState.sessions).toBe(sessionSubscription.rows);
	});

	it("takes what the shell subscription delivers", () => {
		// The annotation is the point: this is the compile-time proof that the
		// wire envelope fits the applier, before ni8.5.20 wires the stream to it.
		const envelope: ShellEnvelope = {
			_tag: "upsert",
			item: session("s1", "from the wire"),
			sequence: 7,
		};
		applySessionChange(envelope);

		expect(findSession("s1")?.title).toBe("from the wire");
	});

	it("settles when the server says we hold everything", () => {
		expect(sessionSubscription.settled).toBe(false);
		applySessionChange({ _tag: "synchronized" });
		expect(sessionSubscription.settled).toBe(true);
	});
});

describe("the store's own apply door", () => {
	it("writes through to the subscription's map", () => {
		applySessionUpsert(session("s1"));
		expect(sessionSubscription.rows.get("s1")?.title).toBe("s1");

		applySessionUpsert(session("s1", "renamed"));
		expect(sessionSubscription.rows.get("s1")?.title).toBe("renamed");
	});

	it("preserves the previous map across a write", () => {
		applySessionUpsert(session("s1"));
		const previous = sessionState.sessions;
		applySessionUpsert(session("s1", "renamed"));
		expect(previous.get("s1")?.title).toBe("s1");
		expect(sessionState.sessions).not.toBe(previous);
	});

	it("delivers store writes to a reactive consumer", async () => {
		const observed: (string | undefined)[] = [];
		const unsubscribe = observeSessionTitle("s1", (title) =>
			observed.push(title),
		);
		try {
			await Promise.resolve();
			applySessionUpsert(session("s1"));
			await Promise.resolve();
			applySessionUpsert(session("s1", "renamed"));
			await Promise.resolve();
			expect(observed).toEqual([undefined, "s1", "renamed"]);
		} finally {
			unsubscribe();
		}
	});

	it("reaps on a complete snapshot and leaves a partial one alone", () => {
		applySessionUpsert(session("held"));

		applySessionSnapshot([session("s1")], "partial");
		expect(ids()).toEqual(["held", "s1"]);

		applySessionSnapshot([session("s1")], "complete");
		expect(ids()).toEqual(["s1"]);
	});

	it("drops the tab's selection with the session it was on", () => {
		applySessionUpsert(session("s1"));
		sessionState.currentId = "s1";

		applySessionRemoved("s1");

		expect(ids()).toEqual([]);
		expect(sessionState.currentId).toBeNull();
	});

	it("does not touch the selection when another session goes", () => {
		applySessionSnapshot([session("s1"), session("s2")], "complete");
		sessionState.currentId = "s1";

		applySessionRemoved("s2");

		expect(sessionState.currentId).toBe("s1");
	});

	it("empties the map and unsettles when the project changes", () => {
		applySessionChange({
			_tag: "snapshot",
			rows: [session("s1")],
			sequence: 9,
		});
		applySessionChange({ _tag: "synchronized" });

		clearSessionState();

		expect(ids()).toEqual([]);
		expect(sessionSubscription.settled).toBe(false);
		// The old project's sequences must not cover the new one's changes.
		applySessionChange({ _tag: "upsert", item: session("s9"), sequence: 1 });
		expect(ids()).toEqual(["s9"]);
	});
});
