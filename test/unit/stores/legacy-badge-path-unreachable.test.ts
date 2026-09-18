// ─── The Legacy Badge Path Is Unreachable (ni8.23) ───────────────────────────
// The badge used to be client state: a reducer fed by `notification_event`
// broadcasts, plus a per-tab set of "sessions I have looked at". Both are gone —
// what a session is waiting on, and whether it has been looked at, are derived
// server-side onto the session row.
//
// Deleting code is not the same as making it unreachable, and the way this
// regresses is quiet: someone re-adds a local counter "just for responsiveness",
// it drifts from the row, and two tabs disagree about a badge with no error
// anywhere. So this test asserts both halves — that the source can no longer
// reach the old path, and that a legacy broadcast changes no badge at runtime.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	applySessionSnapshot,
	clearSessionState,
	getAttentionSessions,
	getSessionIndicator,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { handleMessage } from "../../../src/lib/frontend/stores/ws-dispatch.js";

const REPO_ROOT = process.cwd();
const FRONTEND = join(REPO_ROOT, "src/lib/frontend");

/** Every .ts/.svelte file under a directory, as repo-relative paths. */
function sourceFiles(dir: string): readonly string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of readdirSync(current)) {
			const full = join(current, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (entry.endsWith(".ts") || entry.endsWith(".svelte"))
				found.push(relative(REPO_ROOT, full));
		}
	};
	walk(dir);
	return found;
}

/** Repo-relative paths whose contents match, with the matching line. */
function matches(files: readonly string[], pattern: RegExp): readonly string[] {
	const hits: string[] = [];
	for (const file of files) {
		for (const line of readFileSync(join(REPO_ROOT, file), "utf8").split(
			"\n",
		)) {
			if (pattern.test(line)) hits.push(`${file}: ${line.trim()}`);
		}
	}
	return hits;
}

describe("the legacy badge path is unreachable", () => {
	const frontendFiles = sourceFiles(FRONTEND);

	it("has no notification reducer module left to import", () => {
		expect(
			existsSync(join(FRONTEND, "stores/notification-reducer.svelte.ts")),
		).toBe(false);
		expect(matches(frontendFiles, /notification-reducer/)).toEqual([]);
	});

	it("keeps no client-local record of which sessions were viewed", () => {
		// `last_viewed_at` lives in one place: a column on the session row the
		// server compares for us. A second copy in the browser is the drift.
		expect(
			matches(
				frontendFiles,
				/viewedSessions|sessionsViewed|lastViewedAt|markViewed|notifState/,
			),
		).toEqual([]);
	});

	it("never sends or acts on a session_viewed notification", () => {
		// Viewing is an RPC with a read-model write behind it, not a broadcast:
		// the row comes back with its badge already cleared, for every client.
		expect(matches(frontendFiles, /session_viewed/)).toEqual([]);
	});

	it("draws the sidebar dot from nothing but the server's row", () => {
		const store = readFileSync(
			join(FRONTEND, "stores/session.svelte.ts"),
			"utf8",
		);
		const indicator = store.slice(
			store.indexOf("export function getSessionIndicator"),
			store.indexOf("export function getAttentionSessions"),
		);
		expect(indicator).toContain("serverSessions.get(sessionId)");
		expect(indicator).toMatch(/pendingQuestions|pendingPermissions/);
		expect(indicator).toContain("unseenActivity");
	});
});

describe("a legacy notification broadcast moves no badge", () => {
	beforeEach(() => {
		clearSessionState();
		sessionState.currentId = "ses_current";
		applySessionSnapshot(
			[
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
					pendingQuestions: 0,
					pendingPermissions: 0,
					unseenActivity: false,
				},
			],
			"complete",
		);
	});

	it("leaves the indicator alone for ask_user, done and error", () => {
		for (const eventType of ["ask_user", "done", "error"] as const) {
			handleMessage({
				type: "notification_event",
				eventType,
				sessionId: "ses_other",
			});
			expect(getSessionIndicator("ses_other", "ses_current")).toBeNull();
		}
		expect(
			getAttentionSessions("ses_current", () => new Set<string>()).size,
		).toBe(0);
	});

	it("shows the badge only once the row itself says so", () => {
		handleMessage({
			type: "notification_event",
			eventType: "ask_user",
			sessionId: "ses_other",
		});
		expect(getSessionIndicator("ses_other", "ses_current")).toBeNull();

		applySessionSnapshot(
			[
				{
					id: "ses_other",
					title: "Other",
					status: "idle",
					createdAt: Date.now(),
					pendingQuestions: 1,
				},
			],
			"complete",
		);

		expect(getSessionIndicator("ses_other", "ses_current")).toBe("attention");
	});
});
