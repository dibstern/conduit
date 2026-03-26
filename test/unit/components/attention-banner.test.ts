// ─── AttentionBanner Merge Logic Test ──────────────────────────────────────────
// Verifies that AttentionBanner correctly merges two data sources:
// 1. Local pending permissions (from permissions store)
// 2. Attention sessions (from notification reducer)
//
// The merge logic lives in a $derived.by() block inside the component, so we
// test it by rendering the component and asserting on visible output.
//
// Uses @testing-library/svelte + jsdom (vitest "components" project).

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock ws store ──────────────────────────────────────────────────────────
// Only wsSend is needed by AttentionBanner (passed to switchToSession).

const wsSendSpy = vi.fn();

vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", () => ({
	wsSend: (...args: unknown[]) => wsSendSpy(...args),
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import AttentionBanner from "../../../src/lib/frontend/components/permissions/AttentionBanner.svelte";
import {
	dispatch,
	resetNotifState,
} from "../../../src/lib/frontend/stores/notification-reducer.svelte.js";
import { permissionsState } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type { PermissionId } from "../../../src/lib/frontend/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal permission request for the given session. */
function makePerm(id: string, sessionId: string) {
	return {
		id,
		requestId: id as PermissionId,
		sessionId,
		toolName: "bash",
		toolInput: {},
	};
}

/** Set up session titles so getSessionTitle() returns readable names. */
function setSessionTitles(titles: Record<string, string>) {
	sessionState.allSessions = Object.entries(titles).map(([id, title]) => ({
		id,
		title,
		createdAt: Date.now(),
	})) as typeof sessionState.allSessions;
}

/** Render component and flush reactive updates. */
async function renderBanner() {
	const result = render(AttentionBanner);
	flushSync();
	await tick();
	return result;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("AttentionBanner merge logic", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetNotifState();
		permissionsState.pendingPermissions = [];
		permissionsState.pendingQuestions = [];
		sessionState.currentId = "ses_current";
		sessionState.rootSessions = [];
		sessionState.allSessions = [];
	});

	afterEach(() => {
		cleanup();
	});

	it("shows nothing when no sessions need attention", async () => {
		await renderBanner();

		expect(screen.queryByRole("status")).toBeNull();
	});

	it("shows permission-only sessions from local permissions store", async () => {
		permissionsState.pendingPermissions = [
			makePerm("perm-1", "ses_other1"),
			makePerm("perm-2", "ses_other1"),
			makePerm("perm-3", "ses_other2"),
		];
		setSessionTitles({
			ses_other1: "Fix auth bug",
			ses_other2: "Refactor DB",
		});

		await renderBanner();

		const status = screen.getByRole("status");
		expect(status).toBeTruthy();
		// Should show "2 sessions need attention"
		expect(status.textContent).toContain("2 sessions");
		expect(status.textContent).toContain("need attention");
		// Should show session titles with permission counts
		expect(status.textContent).toContain("Fix auth bug");
		expect(status.textContent).toContain("2 permissions");
		expect(status.textContent).toContain("Refactor DB");
		expect(status.textContent).toContain("1 permission");
	});

	it("shows question-only sessions from notification reducer", async () => {
		dispatch({ type: "question_appeared", sessionId: "ses_other1" });
		dispatch({ type: "question_appeared", sessionId: "ses_other1" });
		setSessionTitles({ ses_other1: "API redesign" });

		await renderBanner();

		const status = screen.getByRole("status");
		expect(status).toBeTruthy();
		expect(status.textContent).toContain("1 session");
		expect(status.textContent).toContain("needs attention");
		expect(status.textContent).toContain("API redesign");
		expect(status.textContent).toContain("2 questions");
	});

	it("merges permissions from both sources using Math.max", async () => {
		// Local store has 3 permissions for ses_other1
		permissionsState.pendingPermissions = [
			makePerm("perm-1", "ses_other1"),
			makePerm("perm-2", "ses_other1"),
			makePerm("perm-3", "ses_other1"),
		];
		// Reducer has 2 permissions + 1 question for ses_other1
		dispatch({ type: "permission_appeared", sessionId: "ses_other1" });
		dispatch({ type: "permission_appeared", sessionId: "ses_other1" });
		dispatch({ type: "question_appeared", sessionId: "ses_other1" });
		setSessionTitles({ ses_other1: "Merge session" });

		await renderBanner();

		const status = screen.getByRole("status");
		expect(status).toBeTruthy();
		// Math.max(3 local, 2 reducer) = 3 permissions, plus 1 question
		expect(status.textContent).toContain("3 permissions");
		expect(status.textContent).toContain("1 question");
	});

	it("takes reducer count when it exceeds local count", async () => {
		// Local store has 1 permission for ses_other1
		permissionsState.pendingPermissions = [makePerm("perm-1", "ses_other1")];
		// Reducer has 5 permissions for ses_other1 (server reconciled higher)
		for (let i = 0; i < 5; i++) {
			dispatch({ type: "permission_appeared", sessionId: "ses_other1" });
		}
		setSessionTitles({ ses_other1: "Big session" });

		await renderBanner();

		const status = screen.getByRole("status");
		// Math.max(1 local, 5 reducer) = 5
		expect(status.textContent).toContain("5 permissions");
	});

	it("excludes the current session from display", async () => {
		// Permissions for current session should NOT appear
		permissionsState.pendingPermissions = [
			makePerm("perm-1", "ses_current"),
			makePerm("perm-2", "ses_other1"),
		];
		// Reducer attention for current session should NOT appear
		dispatch({ type: "question_appeared", sessionId: "ses_current" });
		setSessionTitles({
			ses_current: "Current session",
			ses_other1: "Other session",
		});

		await renderBanner();

		const status = screen.getByRole("status");
		expect(status).toBeTruthy();
		// Only ses_other1 should show, NOT ses_current
		expect(status.textContent).toContain("1 session");
		expect(status.textContent).toContain("Other session");
		expect(status.textContent).not.toContain("Current session");
	});

	it("excludes descendant sessions from display", async () => {
		// Set up parent/child relationship: ses_current → ses_child1
		sessionState.allSessions = [
			{ id: "ses_current", title: "Parent", createdAt: Date.now() },
			{
				id: "ses_child1",
				title: "Child session",
				createdAt: Date.now(),
				parentID: "ses_current",
			},
			{ id: "ses_other1", title: "Unrelated session", createdAt: Date.now() },
		] as typeof sessionState.allSessions;

		// Permissions for child session should NOT appear (shown inline)
		permissionsState.pendingPermissions = [
			makePerm("perm-1", "ses_child1"),
			makePerm("perm-2", "ses_other1"),
		];
		// Reducer attention for child session should NOT appear
		dispatch({ type: "question_appeared", sessionId: "ses_child1" });

		await renderBanner();

		const status = screen.getByRole("status");
		expect(status).toBeTruthy();
		// Only ses_other1 should show
		expect(status.textContent).toContain("1 session");
		expect(status.textContent).toContain("Unrelated session");
		expect(status.textContent).not.toContain("Child session");
	});

	it("dispatches session_viewed and switches session on click", async () => {
		permissionsState.pendingPermissions = [makePerm("perm-1", "ses_other1")];
		setSessionTitles({ ses_other1: "Clickable session" });

		await renderBanner();

		const sessionButton = screen.getByText(/Clickable session/);
		await fireEvent.click(sessionButton);

		// switchToSession sends view_session via wsSend
		expect(wsSendSpy).toHaveBeenCalledWith({
			type: "view_session",
			sessionId: "ses_other1",
		});
	});

	it("hides after dismiss, reappears when new session arrives", async () => {
		permissionsState.pendingPermissions = [makePerm("perm-1", "ses_other1")];
		setSessionTitles({ ses_other1: "Session A" });

		await renderBanner();
		expect(screen.getByRole("status")).toBeTruthy();

		// Click dismiss
		const dismissBtn = screen.getByLabelText("Dismiss notification");
		await fireEvent.click(dismissBtn);

		flushSync();
		await tick();

		// Should be hidden
		expect(screen.queryByRole("status")).toBeNull();

		// New session arrives — banner reappears
		permissionsState.pendingPermissions = [
			makePerm("perm-1", "ses_other1"),
			makePerm("perm-2", "ses_other2"),
		];
		setSessionTitles({
			ses_other1: "Session A",
			ses_other2: "Session B",
		});

		flushSync();
		await tick();

		expect(screen.getByRole("status")).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("2 sessions");
	});

	it("shows truncated session ID when session title is not found", async () => {
		dispatch({ type: "question_appeared", sessionId: "ses_unknown_long_id" });
		// Don't set any session titles — findSession will return undefined

		await renderBanner();

		const status = screen.getByRole("status");
		// Should show truncated ID: first 8 chars + ellipsis
		expect(status.textContent).toContain("ses_unkn\u2026");
	});

	it("shows both permissions and questions for the same session", async () => {
		permissionsState.pendingPermissions = [makePerm("perm-1", "ses_other1")];
		dispatch({ type: "question_appeared", sessionId: "ses_other1" });
		setSessionTitles({ ses_other1: "Mixed session" });

		await renderBanner();

		const status = screen.getByRole("status");
		expect(status.textContent).toContain("1 session");
		expect(status.textContent).toContain("needs attention");
		expect(status.textContent).toContain("1 permission");
		expect(status.textContent).toContain("1 question");
	});
});
