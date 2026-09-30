import { describe, expect, it } from "vitest";
import {
	findSessionVerbForKey,
	getSessionVerbs,
	sessionVerbKeys,
	sessionVerbKeysHint,
} from "../../../src/lib/frontend/components/session/session-verbs.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

const now = Date.now();
const host = { rename: () => {} };
const plain = {
	altKey: false,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	repeat: false,
};

function press(
	session: SessionInfo,
	event: Partial<typeof plain> & { key: string },
): string | undefined {
	return findSessionVerbForKey(getSessionVerbs(session, now, host, "center"), {
		...plain,
		...event,
	})?.testId;
}

const open: SessionInfo = { id: "s1", title: "Open" };

describe("session verb shortcuts", () => {
	it("runs each plain key's verb, following its current toggle state", () => {
		expect(press(open, { key: "s" })).toBe("session-ctx-settle");
		expect(press({ ...open, settledAt: now }, { key: "s" })).toBe(
			"session-ctx-unsettle",
		);
		expect(press(open, { key: "z" })).toBe("session-ctx-snooze");
		expect(press({ ...open, snoozedAt: now }, { key: "z" })).toBe(
			"session-ctx-unsnooze",
		);
		expect(press(open, { key: "p" })).toBe("session-ctx-pin");
		expect(press({ ...open, pinnedAt: now }, { key: "p" })).toBe(
			"session-ctx-unpin",
		);
		expect(press({ ...open, unread: true }, { key: "u" })).toBe(
			"session-ctx-mark-read",
		);
		expect(press(open, { key: "r" })).toBe("session-ctx-rename");
	});

	it("runs global verbs with ⌘⇧ or Ctrl+Shift", () => {
		expect(press(open, { key: "E", metaKey: true, shiftKey: true })).toBe(
			"session-ctx-settle",
		);
		expect(press(open, { key: "U", ctrlKey: true, shiftKey: true })).toBe(
			"session-ctx-mark-unread",
		);
	});

	it("ignores other modifier combinations and key repeat", () => {
		for (const event of [
			{ key: "s", altKey: true },
			{ key: "s", repeat: true },
			{ key: "S", shiftKey: true },
			{ key: "s", metaKey: true },
			{ key: "S", metaKey: true, shiftKey: true },
			{ key: "E", metaKey: true, shiftKey: true, altKey: true },
		])
			expect(press(open, event)).toBeUndefined();
	});

	it("offers a foreign session only the verbs its menu offers", () => {
		const foreign = { ...open, projectSlug: "elsewhere" };
		expect(press(foreign, { key: "u" })).toBe("session-ctx-mark-unread");
		expect(press(foreign, { key: "s" })).toBeUndefined();
	});

	it("shows the same keys it matches", () => {
		expect(sessionVerbKeysHint(sessionVerbKeys.settle)).toBe("s · ⌘⇧E");
		expect(sessionVerbKeysHint(sessionVerbKeys.read)).toBe("u · ⌘⇧U");
		expect(sessionVerbKeysHint(sessionVerbKeys.pin)).toBe("p");
	});
});
