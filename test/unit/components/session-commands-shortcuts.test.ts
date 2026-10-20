import { describe, expect, it } from "vitest";
import {
	findSessionCommandForKey,
	getSessionCommands,
	sessionCommandKeys,
	sessionCommandKeysHint,
} from "../../../src/lib/frontend/components/session/session-commands.js";
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
	return findSessionCommandForKey(
		getSessionCommands(session, now, host, "center"),
		{
			...plain,
			...event,
		},
	)?.testId;
}

const open: SessionInfo = {
	projectSlug: "test-project",
	accountId: null,
	id: "s1",
	title: "Open",
	status: "idle",
};

describe("session command shortcuts", () => {
	it("runs each plain key's command, following its current toggle state", () => {
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

	it("runs global commands with ⌘⇧ or Ctrl+Shift", () => {
		for (const modifier of ["metaKey", "ctrlKey"] as const)
			expect(press(open, { key: "S", [modifier]: true, shiftKey: true })).toBe(
				"session-ctx-settle",
			);
		// Keep the previous global binding available to existing users.
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
			{ key: "E", metaKey: true, shiftKey: true, altKey: true },
		])
			expect(press(open, event)).toBeUndefined();
	});

	it("gives a session from another project the same keys", () => {
		const foreign = { ...open, projectSlug: "elsewhere" };
		expect(press(foreign, { key: "u" })).toBe("session-ctx-mark-unread");
		expect(press(foreign, { key: "s" })).toBe("session-ctx-settle");
	});

	it("shows the same keys it matches", () => {
		expect(sessionCommandKeysHint(sessionCommandKeys.settle)).toBe("s · ⌘⇧S");
		expect(sessionCommandKeysHint(sessionCommandKeys.read)).toBe("u · ⌘⇧U");
		expect(sessionCommandKeysHint(sessionCommandKeys.pin)).toBe("p");
	});
});
