import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	applyApprovalEnvelope,
	buildAnswerPayload,
	clearAll,
	clearAllPermissions,
	formatQuestionHeader,
	getDescendantSessionIds,
	getLocalPermissions,
	getRemotePermissions,
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
} from "../../../src/lib/frontend/types.js";
import type { Approval } from "../../../src/lib/shared-types.js";
import { seedSessionsWithFamily } from "./session-fixtures.js";

/** Cast a plain string to PermissionId for test data. */
const pid = (s: string) => s as PermissionId;

// The approvals subscription is the store's only writer: seed it the same way.
let sequence = 0;
const upsert = (item: Approval) =>
	applyApprovalEnvelope({ _tag: "upsert", item, sequence: ++sequence });
const permissionAsked = (
	fields: Omit<Extract<Approval, { _tag: "permission" }>, "_tag">,
) => upsert({ _tag: "permission", ...fields });
const questionAsked = (
	fields: Omit<Extract<Approval, { _tag: "question" }>, "_tag">,
) => upsert({ _tag: "question", ...fields });

beforeEach(() => {
	clearAll();
	clearSessionState();
});

describe("applyApprovalEnvelope", () => {
	const question = {
		_tag: "question",
		sessionId: "s1",
		toolId: "que-1",
		toolUseId: "call-1",
		providerId: "opencode",
		questions: [
			{
				question: "Which?",
				header: "Pick",
				options: [{ label: "A" }],
				multiSelect: false,
			},
		],
	} as const;
	const permission = {
		_tag: "permission",
		sessionId: "child-1",
		requestId: pid("perm-1"),
		toolName: "Bash",
		toolInput: { command: "ls" },
		always: ["ls *"],
		permissionTitle: "Run ls",
	} as const;

	it("drives both lists from snapshot, upsert and remove, and reports what entered", () => {
		expect(
			applyApprovalEnvelope({
				_tag: "snapshot",
				rows: [question],
				sequence: 5,
			}),
		).toEqual([question]);
		expect(applyApprovalEnvelope({ _tag: "synchronized" })).toEqual([]);
		expect(permissionsState.pendingQuestions).toEqual([
			{
				toolId: "que-1",
				sessionId: "s1",
				toolUseId: "call-1",
				providerId: "opencode",
				questions: question.questions,
			},
		]);

		expect(
			applyApprovalEnvelope({ _tag: "upsert", item: permission, sequence: 6 }),
		).toEqual([permission]);
		expect(permissionsState.pendingPermissions).toEqual([
			{
				id: "perm-1",
				requestId: "perm-1",
				sessionId: "child-1",
				toolName: "Bash",
				toolInput: { command: "ls" },
				always: ["ls *"],
				permissionTitle: "Run ls",
			},
		]);

		// A replayed upsert at or below what we hold is not news.
		expect(
			applyApprovalEnvelope({ _tag: "upsert", item: permission, sequence: 6 }),
		).toEqual([]);

		applyApprovalEnvelope({ _tag: "remove", id: "perm-1", sequence: 7 });
		applyApprovalEnvelope({ _tag: "remove", id: "que-1", sequence: 8 });
		expect(permissionsState.pendingPermissions).toEqual([]);
		expect(permissionsState.pendingQuestions).toEqual([]);
	});

	it("a reconnect snapshot reports only approvals it did not already hold", () => {
		applyApprovalEnvelope({ _tag: "snapshot", rows: [question], sequence: 5 });
		applyApprovalEnvelope({ _tag: "synchronized" });
		expect(
			applyApprovalEnvelope({
				_tag: "snapshot",
				rows: [question, permission],
				sequence: 9,
			}),
		).toEqual([permission]);
		// And one that leaves an approval out has resolved it while we were away.
		applyApprovalEnvelope({
			_tag: "snapshot",
			rows: [permission],
			sequence: 10,
		});
		expect(permissionsState.pendingQuestions).toEqual([]);
		expect(permissionsState.pendingPermissions.map((p) => p.id)).toEqual([
			"perm-1",
		]);
	});

	it("a project switch forgets everything, so the next snapshot starts clean", () => {
		applyApprovalEnvelope({ _tag: "snapshot", rows: [question], sequence: 50 });
		clearAllPermissions();
		expect(permissionsState.pendingQuestions).toEqual([]);
		// Another project's store is at a lower sequence; it must still apply.
		expect(
			applyApprovalEnvelope({
				_tag: "snapshot",
				rows: [permission],
				sequence: 3,
			}),
		).toEqual([permission]);
	});
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

describe("removePermission", () => {
	it("removes by requestId", () => {
		permissionAsked({
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		permissionAsked({
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
		questionAsked({
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
		permissionAsked({
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		questionAsked({
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
});

describe("clearAllPermissions", () => {
	it("clears all pending items", () => {
		permissionAsked({
			sessionId: "ses-1",
			requestId: pid("r1"),
			toolName: "Write",
			toolInput: {},
		});
		questionAsked({
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
		clearAllPermissions();

		expect(permissionsState.pendingPermissions).toHaveLength(0);
		expect(permissionsState.pendingQuestions).toHaveLength(0);
	});
});

describe("getLocalPermissions", () => {
	it("returns only permissions matching the current session", () => {
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		expect(getLocalPermissions(null)).toHaveLength(0);
	});

	it("returns empty array when no permissions match", () => {
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		expect(getRemotePermissions(null)).toHaveLength(1);
	});

	it("returns empty array when all permissions are local", () => {
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		questionAsked({
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
		permissionAsked({
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
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "parent",
			toolName: "Write",
			toolInput: {},
		});
		permissionAsked({
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
		permissionAsked({
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
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "sess-1",
			toolName: "Write",
			toolInput: {},
		});
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r-unknown"),
			sessionId: "",
			toolName: "Bash",
			toolInput: {},
		});

		const remote = getRemotePermissions("sess-1");
		expect(remote).toHaveLength(0);
	});

	it("keeps other-session permissions in remote while excluding empty-session ones", () => {
		permissionAsked({
			requestId: pid("r-unknown"),
			sessionId: "",
			toolName: "Bash",
			toolInput: {},
		});
		permissionAsked({
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
		permissionAsked({
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
		permissionAsked({
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
		permissionAsked({
			requestId: pid("r1"),
			sessionId: "grandchild",
			toolName: "Bash",
			toolInput: {},
		});
		permissionAsked({
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
