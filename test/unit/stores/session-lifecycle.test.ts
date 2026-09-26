import { describe, expect, it } from "vitest";
import { mockSession } from "../../../src/lib/frontend/stories/mocks.js";
import {
	getSessionBarState,
	getWokenSessionText,
} from "../../../src/lib/frontend/utils/session-lifecycle.js";

const now = Date.UTC(2026, 8, 27, 10);

describe("session bar state", () => {
	it("has no chip for a live session or missing session", () => {
		expect(getSessionBarState(mockSession, now)).toBeNull();
		expect(getSessionBarState(undefined, now)).toBeNull();
	});

	it("distinguishes manual and automatic settlement", () => {
		expect(
			getSessionBarState({ ...mockSession, settledAt: now }, now),
		).toMatchObject({ kind: "settled", label: "Settled" });
		expect(
			getSessionBarState(
				{ ...mockSession, settledAt: now, settledAutomatically: true },
				now,
			),
		).toMatchObject({ kind: "auto-settled", label: "Auto-settled" });
	});

	it("prioritizes settlement over snooze and wake, then snooze over wake", () => {
		const session = {
			...mockSession,
			snoozedAt: now - 1000,
			snoozedUntil: now + 3_600_000,
			wokenAt: now - 500,
		};
		expect(getSessionBarState({ ...session, settledAt: now }, now)?.kind).toBe(
			"settled",
		);
		expect(getSessionBarState(session, now)?.kind).toBe("snoozed");
		expect(
			getSessionBarState({ ...session, snoozedUntil: now }, now)?.kind,
		).toBe("woke");
		expect(
			getSessionBarState(
				{ ...mockSession, snoozedAt: now - 1000, snoozedUntil: now },
				now,
			),
		).toMatchObject({ kind: "woke", label: "Woke" });
		expect(
			getSessionBarState({ ...mockSession, snoozedAt: now - 1000 }, now)?.kind,
		).toBe("snoozed");
	});

	it("uses the row's wake reason labels", () => {
		expect(
			getWokenSessionText({
				...mockSession,
				wokenAt: now,
				wokeBecause: "error",
			}),
		).toBe("Woke · failed");
		expect(
			getWokenSessionText({
				...mockSession,
				wokenAt: now,
				wokeBecause: "turn",
			}),
		).toBe("Woke · done");
		expect(
			getSessionBarState(
				{ ...mockSession, wokenAt: now, wokeBecause: "question" },
				now,
			),
		).toMatchObject({ kind: "woke", label: "Woke · question" });
	});
});
