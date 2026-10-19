import { describe, expect, it } from "vitest";
import { getSessionCommands } from "../../../src/lib/frontend/components/session/session-commands.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

const now = new Date(2026, 9, 17, 16).getTime();
const until = new Date(2026, 9, 17, 18).getTime();
const session: SessionInfo = {
	id: "session",
	title: "Session",
	status: "idle",
	projectSlug: "test",
	accountId: null,
};
const host = { rename: () => {}, select: () => {} };

describe("session command presentation model", () => {
	it.each([
		false,
		true,
	])("retains full labels alongside tile labels, unread=%s", (unread) => {
		const commands = getSessionCommands(
			{ ...session, unread },
			now,
			host,
			"sheet",
		);
		for (const [testId, label, shortLabel] of [
			["session-ctx-pin", "Pin to top", "Pin"],
			[
				unread ? "session-ctx-mark-read" : "session-ctx-mark-unread",
				unread ? "Mark read" : "Mark unread",
				unread ? "Read" : "Unread",
			],
			["session-ctx-copy-resume", "Copy resume command", "Copy resume"],
			["session-ctx-snooze", "Snooze…", "Snooze"],
		])
			expect(
				commands.find((command) => command.testId === testId),
			).toMatchObject({ label, shortLabel });
	});

	it.each([
		[{}, "session-ctx-settle"],
		[{ settledAt: now }, undefined],
		[{ pinnedAt: now }, "session-ctx-unpin"],
		[{ pinnedAt: now, settledAt: now }, "session-ctx-unpin"],
		[{ snoozedAt: now, snoozedUntil: until }, "session-ctx-settle"],
	] satisfies [
		Partial<SessionInfo>,
		string | undefined,
	][])("emphasizes only the available primary command for %j", (state, primary) => {
		const commands = getSessionCommands(
			{ ...session, ...state },
			now,
			host,
			"sheet",
		);
		expect(
			commands
				.filter(({ emphasis }) => emphasis === "primary")
				.map(({ testId }) => testId),
		).toEqual(primary ? [primary] : []);
	});

	it.each<[Partial<SessionInfo>, string]>([
		[
			{ snoozedAt: now, snoozedUntil: until },
			`until ${new Date(until).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`,
		],
		[{ snoozedAt: now }, "No timer"],
		[{ snoozedAt: now, snoozedUntil: until, pinnedAt: now }, "Unpin to snooze"],
		[
			{ snoozedAt: now, snoozedUntil: until, attention: "needs-reply" },
			"Waiting on you",
		],
		[{ snoozedAt: now, attention: "needs-approval" }, "Waiting on you"],
	])("resolves snooze details for %j", (state, detail) => {
		const commands = getSessionCommands(
			{ ...session, ...state },
			now,
			host,
			"sheet",
		);
		expect(
			commands.find(({ testId }) => testId === "session-ctx-snooze"),
		).toMatchObject({
			label: "Change snooze…",
			shortLabel: "Snooze",
			detail,
		});
		if (state.pinnedAt != null)
			expect(commands[0]).toMatchObject({ detail: "Unpin to settle" });
		expect(
			commands.some(({ testId }) => testId === "session-ctx-unsnooze"),
		).toBe(true);
		expect(
			commands.some(({ testId }) => testId?.startsWith("session-ctx-mark-")),
		).toBe(false);
	});

	it("omits expired snooze details and commands the host does not offer", () => {
		const commands = getSessionCommands(
			{ ...session, snoozedAt: now - 1000, snoozedUntil: now },
			now,
			{ rename: host.rename },
			"center",
		);
		expect(
			commands.find(({ testId }) => testId === "session-ctx-snooze")?.detail,
		).toBeNull();
		expect(
			commands.some(
				({ testId }) =>
					testId === "session-ctx-unsnooze" || testId === "session-ctx-select",
			),
		).toBe(false);
	});
});
