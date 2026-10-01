import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	buildAnswerPayload,
	clearAll,
	clearAllPermissions,
	formatQuestionHeader,
	getDescendantSessionIds,
	getLocalPermissions,
	getRemotePermissions,
	handleAskUser,
	handleAskUserError,
	handleAskUserResolved,
	handlePermissionRequest,
	handlePermissionResolved,
	isValidSubmission,
	permissionsState,
	removePermission,
	removeQuestion,
	shouldAutoSubmit,
} from "../../../src/lib/frontend/stores/permissions.svelte.js";
import { routerState } from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import type {
	AskUserQuestion,
	PermissionId,
	RelayMessage,
} from "../../../src/lib/frontend/types.js";
import { seedSessionsWithFamily } from "./session-fixtures.js";

/** Cast a plain string to PermissionId for test data. */
const pid = (s: string) => s as PermissionId;

// Tests deliberately pass incomplete objects to verify defensive handling.
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

beforeEach(() => {
	permissionsState.pendingPermissions = [];
	permissionsState.pendingQuestions = [];
	permissionsState.questionErrors = new Map();
	clearSessionState();
});

describe("buildAnswerPayload", () => {
	it("builds answer payload from selections", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Pick a color",
				header: "Color",
				options: [{ label: "Red" }, { label: "Blue" }],
				multiSelect: false,
			},
			{
				question: "Pick a size",
				header: "Size",
				options: [{ label: "S" }, { label: "L" }],
				multiSelect: false,
			},
		];
		const selections = new Map<number, string>([
			[0, "Red"],
			[1, "L"],
		]);
		const result = buildAnswerPayload(selections, questions);
		// Keys are numeric string indices, not question text
		expect(result).toEqual({
			"0": "Red",
			"1": "L",
		});
	});

	it("ignores out-of-bounds indices", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Q1",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
			},
		];
		const selections = new Map<number, string>([
			[0, "A"],
			[5, "invalid"],
		]);
		const result = buildAnswerPayload(selections, questions);
		// Only index 0 is within bounds
		expect(result).toEqual({ "0": "A" });
	});
});

describe("shouldAutoSubmit", () => {
	it("returns true when all questions have single option, no multiSelect, no custom", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Confirm",
				header: "OK",
				options: [{ label: "Yes" }],
				multiSelect: false,
			},
		];
		expect(shouldAutoSubmit(questions)).toBe(true);
	});

	it("returns false when a question has multiple options", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Pick",
				header: "H",
				options: [{ label: "A" }, { label: "B" }],
				multiSelect: false,
			},
		];
		expect(shouldAutoSubmit(questions)).toBe(false);
	});

	it("returns false when a question has multiSelect", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Q",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: true,
			},
		];
		expect(shouldAutoSubmit(questions)).toBe(false);
	});

	it("returns false when a question has custom input", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Q",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
				custom: true,
			},
		];
		expect(shouldAutoSubmit(questions)).toBe(false);
	});

	it("returns true for empty questions array", () => {
		expect(shouldAutoSubmit([])).toBe(true);
	});
});

describe("isValidSubmission", () => {
	it("returns true when all questions have selections", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Q1",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
			},
			{
				question: "Q2",
				header: "H",
				options: [{ label: "B" }],
				multiSelect: false,
			},
		];
		const selections = new Map<number, string>([
			[0, "A"],
			[1, "B"],
		]);
		expect(isValidSubmission(selections, questions)).toBe(true);
	});

	it("returns false when a question is unanswered", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Q1",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
			},
			{
				question: "Q2",
				header: "H",
				options: [{ label: "B" }],
				multiSelect: false,
			},
		];
		const selections = new Map<number, string>([[0, "A"]]);
		expect(isValidSubmission(selections, questions)).toBe(false);
	});

	it("returns true for empty questions", () => {
		expect(isValidSubmission(new Map(), [])).toBe(true);
	});
});

describe("formatQuestionHeader", () => {
	it("capitalizes first letter", () => {
		expect(formatQuestionHeader("select an option")).toBe("Select an option");
	});

	it("returns empty string for empty input", () => {
		expect(formatQuestionHeader("")).toBe("");
	});

	it("handles already capitalized text", () => {
		expect(formatQuestionHeader("Already")).toBe("Already");
	});
});

describe("handlePermissionRequest", () => {
	it("adds a permission request with toolInput", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: { path: "/foo/bar.ts" },
		});
		expect(permissionsState.pendingPermissions).toHaveLength(1);
		const permission = permissionsState.pendingPermissions[0];
		assert.exists(permission, "expected pending permission");
		expect(permission.toolName).toBe("Write");
		expect(permission.toolInput).toEqual({
			path: "/foo/bar.ts",
		});
	});

	it("ignores missing requestId", () => {
		handlePermissionRequest(
			msg({ type: "permission_request", toolName: "Write" }),
		);
		expect(permissionsState.pendingPermissions).toHaveLength(0);
	});

	it("ignores missing toolName", () => {
		handlePermissionRequest(
			msg({
				type: "permission_request",
				requestId: pid("r1"),
			}),
		);
		expect(permissionsState.pendingPermissions).toHaveLength(0);
	});

	it("preserves the always field from the message", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "bash",
			toolInput: { command: "git status" },
			always: ["git *"],
		});
		expect(permissionsState.pendingPermissions).toHaveLength(1);
		const permission = permissionsState.pendingPermissions[0];
		assert.exists(permission, "expected pending permission");
		expect(permission.always).toEqual(["git *"]);
	});

	it("always adds to pending (no in-memory auto-approve)", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		expect(permissionsState.pendingPermissions).toHaveLength(1);
	});
});

describe("handlePermissionResolved", () => {
	it("removes the resolved permission", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionResolved({
			type: "permission_resolved",
			sessionId: "s1",
			requestId: pid("r1"),
			decision: "allow",
		});
		expect(permissionsState.pendingPermissions).toHaveLength(0);
	});

	it("ignores missing requestId", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionResolved(msg({ type: "permission_resolved" }));
		expect(permissionsState.pendingPermissions).toHaveLength(1);
	});
});

describe("handleAskUser", () => {
	it("adds a question request", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Which?",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
			},
		];
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "t1",
			questions,
		});
		expect(permissionsState.pendingQuestions).toHaveLength(1);
		const question = permissionsState.pendingQuestions[0];
		assert.exists(question, "expected pending question");
		expect(question.toolId).toBe("t1");
	});

	it("ignores missing toolId", () => {
		handleAskUser(
			msg({
				type: "ask_user",
				questions: [
					{
						question: "Q",
						header: "H",
						options: [],
						multiSelect: false,
					},
				],
			}),
		);
		expect(permissionsState.pendingQuestions).toHaveLength(0);
	});

	it("ignores non-array questions", () => {
		handleAskUser(
			msg({
				type: "ask_user",
				sessionId: "s1",
				toolId: "t1",
				questions: "bad",
			}),
		);
		expect(permissionsState.pendingQuestions).toHaveLength(0);
	});

	it("deduplicates ask_user with same toolId (prevents duplicate question cards)", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Which?",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
			},
		];
		// First ask_user adds to pending
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "que_abc",
			questions,
		});
		expect(permissionsState.pendingQuestions).toHaveLength(1);

		// Second ask_user with same toolId (e.g., from API replay after SSE) is ignored
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "que_abc",
			questions,
		});
		expect(permissionsState.pendingQuestions).toHaveLength(1);
	});

	it("allows different toolIds to be added", () => {
		const questions: AskUserQuestion[] = [
			{
				question: "Q",
				header: "H",
				options: [{ label: "A" }],
				multiSelect: false,
			},
		];
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "que_1",
			questions,
		});
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "que_2",
			questions,
		});
		expect(permissionsState.pendingQuestions).toHaveLength(2);
	});
});

describe("handleAskUserResolved", () => {
	it("removes the resolved question", () => {
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "t1",
			questions: [
				{
					question: "Q",
					header: "H",
					options: [{ label: "A" }],
					multiSelect: false,
				},
			],
		});
		handleAskUserResolved({
			type: "ask_user_resolved",
			sessionId: "s1",
			toolId: "t1",
		});
		expect(permissionsState.pendingQuestions).toHaveLength(0);
	});
});

describe("removePermission", () => {
	it("removes by requestId", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r2"),
			toolName: "Read",
			toolInput: {},
		});
		removePermission("r1");
		expect(permissionsState.pendingPermissions).toHaveLength(1);
		const permission = permissionsState.pendingPermissions[0];
		assert.exists(permission, "expected pending permission");
		expect(permission.requestId).toBe("r2");
	});
});

describe("removeQuestion", () => {
	it("removes by toolId", () => {
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "t1",
			questions: [
				{
					question: "Q",
					header: "H",
					options: [{ label: "A" }],
					multiSelect: false,
				},
			],
		});
		removeQuestion("t1");
		expect(permissionsState.pendingQuestions).toHaveLength(0);
	});
});

describe("clearAll", () => {
	it("clears all pending items", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "t1",
			questions: [
				{
					question: "Q",
					header: "H",
					options: [{ label: "A" }],
					multiSelect: false,
				},
			],
		});
		clearAll();
		expect(permissionsState.pendingPermissions).toHaveLength(0);
		expect(permissionsState.pendingQuestions).toHaveLength(0);
	});

	it("clears questionErrors", () => {
		permissionsState.questionErrors.set("t1", "Some error");
		clearAll();
		expect(permissionsState.questionErrors.size).toBe(0);
	});
});

describe("clearAllPermissions", () => {
	it("clears all pending items", () => {
		handlePermissionRequest({
			type: "permission_request",
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		handleAskUser({
			type: "ask_user",
			sessionId: "s1",
			toolId: "t1",
			questions: [
				{
					question: "Q",
					header: "H",
					options: [{ label: "A" }],
					multiSelect: false,
				},
			],
		});
		permissionsState.questionErrors.set("t1", "Some error");

		clearAllPermissions();

		expect(permissionsState.pendingPermissions).toHaveLength(0);
		expect(permissionsState.pendingQuestions).toHaveLength(0);
		expect(permissionsState.questionErrors.size).toBe(0);
	});
});

describe("handleAskUserError", () => {
	it("stores error message keyed by toolId", () => {
		handleAskUserError({
			type: "ask_user_error",
			sessionId: "s1",
			toolId: "t1",
			message: "This question was asked in a terminal session.",
		});
		expect(permissionsState.questionErrors.get("t1")).toBe(
			"This question was asked in a terminal session.",
		);
	});

	it("ignores missing toolId", () => {
		handleAskUserError(
			msg({
				type: "ask_user_error",
				sessionId: "s1",
				toolId: "",
				message: "err",
			}),
		);
		expect(permissionsState.questionErrors.size).toBe(0);
	});

	it("overwrites previous error for the same toolId", () => {
		handleAskUserError({
			type: "ask_user_error",
			sessionId: "s1",
			toolId: "t1",
			message: "first error",
		});
		handleAskUserError({
			type: "ask_user_error",
			sessionId: "s1",
			toolId: "t1",
			message: "second error",
		});
		expect(permissionsState.questionErrors.get("t1")).toBe("second error");
	});
});

describe("getLocalPermissions", () => {
	it("returns only permissions matching the current session", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r2"),
			sessionId: "sess-2",
			toolName: "Bash",
			toolInput: {},
		});
		const local = getLocalPermissions("sess-1");
		expect(local).toHaveLength(1);
		const localPermission = local[0];
		assert.exists(localPermission, "expected local permission");
		expect(localPermission.requestId).toBe("r1");
	});

	it("returns empty array when currentSessionId is null", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		expect(getLocalPermissions(null)).toHaveLength(0);
	});

	it("returns empty array when no permissions match", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		expect(getLocalPermissions("sess-999")).toHaveLength(0);
	});
});

describe("getRemotePermissions", () => {
	it("returns only permissions NOT matching the current session", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r2"),
			sessionId: "sess-2",
			toolName: "Bash",
			toolInput: {},
		});
		const remote = getRemotePermissions("sess-1");
		expect(remote).toHaveLength(1);
		const remotePermission = remote[0];
		assert.exists(remotePermission, "expected remote permission");
		expect(remotePermission.requestId).toBe("r2");
	});

	it("returns all permissions when currentSessionId is null", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		expect(getRemotePermissions(null)).toHaveLength(1);
	});

	it("returns empty array when all permissions are local", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		expect(getRemotePermissions("sess-1")).toHaveLength(0);
	});
});

describe("session switch re-derives", () => {
	it("same permission list, different session → different local/remote split", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r2"),
			sessionId: "sess-2",
			toolName: "Bash",
			toolInput: {},
		});

		// Viewing sess-1: r1 is local, r2 is remote
		expect(getLocalPermissions("sess-1")).toHaveLength(1);
		expect(getRemotePermissions("sess-1")).toHaveLength(1);

		// Viewing sess-2: r2 is local, r1 is remote
		expect(getLocalPermissions("sess-2")).toHaveLength(1);
		expect(getRemotePermissions("sess-2")).toHaveLength(1);
		const localPermission = getLocalPermissions("sess-2")[0];
		const remotePermission = getRemotePermissions("sess-2")[0];
		assert.exists(localPermission, "expected local permission");
		assert.exists(remotePermission, "expected remote permission");
		expect(localPermission.requestId).toBe("r2");
		expect(remotePermission.requestId).toBe("r1");
	});
});

// Pending prompts stay with their sessions when this tab changes routes.
describe("pending prompts across a session switch", () => {
	it("keeps permissions and questions until their resolution events arrive", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		handleAskUser({
			type: "ask_user",
			sessionId: "sess-1",
			toolId: "t1",
			questions: [
				{ question: "Q", header: "H", options: [], multiSelect: false },
			],
		});
		routerState.path = "/s/sess-2";
		sessionState.currentId = "sess-2";
		expect(
			permissionsState.pendingPermissions.map(
				(permission) => permission.requestId,
			),
		).toEqual(["r1"]);
		expect(
			permissionsState.pendingQuestions.map((question) => question.toolId),
		).toEqual(["t1"]);
	});
});

describe("getDescendantSessionIds", () => {
	it("returns empty set when no sessions exist", () => {
		expect(getDescendantSessionIds("parent")).toEqual(new Set());
	});

	it("returns direct child sessions", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child-1",
				title: "Child 1",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
			{
				id: "child-2",
				title: "Child 2",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
			{ id: "unrelated", title: "Unrelated", status: "idle", updatedAt: 0 },
		]);
		const desc = getDescendantSessionIds("parent");
		expect(desc).toEqual(new Set(["child-1", "child-2"]));
	});

	it("returns multi-level descendants (grandchildren)", () => {
		seedSessionsWithFamily([
			{ id: "root", title: "Root", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "root",
				updatedAt: 0,
			},
			{
				id: "grandchild",
				title: "Grandchild",
				status: "idle",
				parentID: "child",
				updatedAt: 0,
			},
		]);
		const desc = getDescendantSessionIds("root");
		expect(desc).toEqual(new Set(["child", "grandchild"]));
	});

	it("does not include the parent itself", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
		]);
		const desc = getDescendantSessionIds("parent");
		expect(desc.has("parent")).toBe(false);
	});
});

describe("getLocalPermissions with subagent hierarchy", () => {
	it("includes permissions from direct child (subagent) sessions", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "child",
			toolName: "Bash",
			toolInput: {},
		});

		const local = getLocalPermissions("parent");
		expect(local).toHaveLength(1);
		const localPermission = local[0];
		assert.exists(localPermission, "expected local permission");
		expect(localPermission.requestId).toBe("r1");
	});

	it("includes permissions from deeply nested subagent sessions", () => {
		seedSessionsWithFamily([
			{ id: "root", title: "Root", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "root",
				updatedAt: 0,
			},
			{
				id: "grandchild",
				title: "GC",
				status: "idle",
				parentID: "child",
				updatedAt: 0,
			},
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "grandchild",
			toolName: "Write",
			toolInput: {},
		});

		const local = getLocalPermissions("root");
		expect(local).toHaveLength(1);
		const localPermission = local[0];
		assert.exists(localPermission, "expected local permission");
		expect(localPermission.requestId).toBe("r1");
	});

	it("includes own permissions alongside descendant permissions", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "parent",
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r2"),
			sessionId: "child",
			toolName: "Bash",
			toolInput: {},
		});

		const local = getLocalPermissions("parent");
		expect(local).toHaveLength(2);
	});

	it("does not include permissions from unrelated sessions", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
			{ id: "other", title: "Other", status: "idle", updatedAt: 0 },
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "other",
			toolName: "Write",
			toolInput: {},
		});

		const local = getLocalPermissions("parent");
		expect(local).toHaveLength(0);
	});
});

// Unknown session (sessionId="") permissions
// When the SSE event lacks sessionID, the relay stores sessionId: "".
// These permissions need human attention and MUST be visible inline regardless
// of which session the user is viewing.

describe("getLocalPermissions with unknown session (sessionId='')", () => {
	it("includes permissions with empty sessionId in the current session", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r-unknown"),
			sessionId: "",
			toolName: "Bash",
			toolInput: { command: "rm -rf /" },
		});

		const local = getLocalPermissions("sess-1");
		expect(local).toHaveLength(1);
		const localPermission = local[0];
		assert.exists(localPermission, "expected local permission");
		expect(localPermission.requestId).toBe("r-unknown");
	});

	it("includes unknown-session permissions alongside session-matched ones", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r-unknown"),
			sessionId: "",
			toolName: "Bash",
			toolInput: {},
		});

		const local = getLocalPermissions("sess-1");
		expect(local).toHaveLength(2);
	});
});

describe("getRemotePermissions with unknown session (sessionId='')", () => {
	it("excludes permissions with empty sessionId (they show as local)", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r-unknown"),
			sessionId: "",
			toolName: "Bash",
			toolInput: {},
		});

		const remote = getRemotePermissions("sess-1");
		expect(remote).toHaveLength(0);
	});

	it("keeps other-session permissions in remote while excluding empty-session ones", () => {
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r-unknown"),
			sessionId: "",
			toolName: "Bash",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r-other"),
			sessionId: "sess-2",
			toolName: "Write",
			toolInput: {},
		});

		const remote = getRemotePermissions("sess-1");
		expect(remote).toHaveLength(1);
		const remotePermission = remote[0];
		assert.exists(remotePermission, "expected remote permission");
		expect(remotePermission.requestId).toBe("r-other");
	});
});

describe("getRemotePermissions with subagent hierarchy", () => {
	it("excludes permissions from child (subagent) sessions", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "child",
			toolName: "Bash",
			toolInput: {},
		});

		const remote = getRemotePermissions("parent");
		expect(remote).toHaveLength(0);
	});

	it("includes permissions from unrelated sessions", () => {
		seedSessionsWithFamily([
			{ id: "parent", title: "Parent", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "parent",
				updatedAt: 0,
			},
			{ id: "other", title: "Other", status: "idle", updatedAt: 0 },
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "other",
			toolName: "Write",
			toolInput: {},
		});

		const remote = getRemotePermissions("parent");
		expect(remote).toHaveLength(1);
		const remotePermission = remote[0];
		assert.exists(remotePermission, "expected remote permission");
		expect(remotePermission.requestId).toBe("r1");
	});

	it("excludes deeply nested descendant permissions from remote", () => {
		seedSessionsWithFamily([
			{ id: "root", title: "Root", status: "idle", updatedAt: 0 },
			{
				id: "child",
				title: "Child",
				status: "idle",
				parentID: "root",
				updatedAt: 0,
			},
			{
				id: "grandchild",
				title: "GC",
				status: "idle",
				parentID: "child",
				updatedAt: 0,
			},
		]);
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r1"),
			sessionId: "grandchild",
			toolName: "Bash",
			toolInput: {},
		});
		handlePermissionRequest({
			type: "permission_request",
			requestId: pid("r2"),
			sessionId: "other-root",
			toolName: "Write",
			toolInput: {},
		});

		const remote = getRemotePermissions("root");
		expect(remote).toHaveLength(1);
		const remotePermission = remote[0];
		assert.exists(remotePermission, "expected remote permission");
		expect(remotePermission.requestId).toBe("r2");
	});
});
