// @vitest-environment jsdom
import { seedSessions } from "./session-fixtures.js";
// The Legacy Badge Path Is Unreachable (ni8.23)
// The badge used to be client state: a reducer fed by the retired
// `notification_event` broadcasts, plus a per-tab set of "sessions I have
// looked at". Both are gone — what a session is waiting on, and whether it has been looked at, are derived
// server-side onto the session row.
//
// Deleting code is not the same as making it unreachable, and the way this
// regresses is quiet: someone re-adds a local counter "just for responsiveness",
// it drifts from the row, and two tabs disagree about a badge with no error
// anywhere. So this test asserts both halves — that the source can no longer
// reach the old path, and that an alert changes no badge at runtime.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import { applyAlert } from "../../../src/lib/frontend/stores/alerts.js";
import {
	clearSessionState,
	getAttentionSessions,
	getSessionIndicator,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";

describe("a legacy notification broadcast moves no badge", () => {
	beforeEach(() => {
		clearSessionState();
		openSessionForSetup("ses_current", "project-a");
		seedSessions([
			{
				id: "ses_current",
				title: "Current",
				status: "idle",
				createdAt: Date.now(),
			},
			{
				id: "ses_other",
				title: "Other",
				status: "idle",
				createdAt: Date.now(),
				pendingQuestionCount: 0,
				pendingPermissionCount: 0,
				unread: false,
			},
		]);
	});

	it("leaves the indicator alone for done and error alerts", () => {
		for (const kind of ["done", "error"] as const) {
			applyAlert({
				_tag: "alert",
				kind,
				alertId: `ses_other:${kind}`,
				sessionId: "ses_other",
			});
			expect(getSessionIndicator("ses_other", "ses_current")).toBeNull();
		}
		expect(
			getAttentionSessions("ses_current", () => new Set<string>()).size,
		).toBe(0);
	});

	it("shows the badge only once the row itself says so", () => {
		applyAlert({
			_tag: "alert",
			kind: "done",
			alertId: "ses_other:done",
			sessionId: "ses_other",
		});
		expect(getSessionIndicator("ses_other", "ses_current")).toBeNull();

		seedSessions([
			{
				id: "ses_other",
				title: "Other",
				status: "idle",
				createdAt: Date.now(),
				pendingQuestionCount: 1,
			},
		]);

		expect(getSessionIndicator("ses_other", "ses_current")).toBe("attention");
	});
});
