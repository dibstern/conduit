// A rename remains a canonical workspace event without turning its cause into a move.
// The RPC preserves folder-specific, typed failures, including empty invalid names.
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionWorkspaceSchema } from "../../../src/lib/contracts/session-workspace.js";
import { SessionWorkspaceChangedPayloadSchema } from "../../../src/lib/contracts/stored-event.js";
import { WorktreeBranchRenameError } from "../../../src/lib/contracts/worktree.js";
import { RenameSessionBranch } from "../../../src/lib/contracts/ws-rpc.js";

describe("session branch rename contracts", () => {
	it("accepts an empty name at the RPC boundary so Git validation supplies the folder", () => {
		expect(
			Schema.decodeUnknownSync(RenameSessionBranch.payloadSchema)({
				_tag: "RenameSessionBranch",
				projectSlug: "project",
				sessionId: "session",
				branchName: "",
			}).branchName,
		).toBe("");
	});
	it("decodes ownership updates while keeping rename out of workspace move causes", () => {
		const event = {
			sessionId: "session",
			cause: "branch-rename",
			origin: "conduit",
			worktrees: { "/repo": "/worktree" },
			ownership: [
				{
					folder: "/repo",
					path: "/worktree",
					branchName: "renamed",
					head: "abc",
				},
			],
		};
		expect(
			Schema.decodeUnknownSync(SessionWorkspaceChangedPayloadSchema)(event),
		).toEqual(event);
		expect(Schema.is(SessionWorkspaceSchema)(event)).toBe(false);
	});
	it("roundtrips folder-specific rename errors", () => {
		const error = new WorktreeBranchRenameError({
			folder: "/library",
			reason: "already-exists",
			message: "Branch already exists",
		});
		expect(
			Schema.decodeUnknownSync(WorktreeBranchRenameError)(
				Schema.encodeSync(WorktreeBranchRenameError)(error),
			),
		).toMatchObject({
			_tag: "WorktreeBranchRenameError",
			folder: "/library",
			reason: "already-exists",
			message: "Branch already exists",
		});
	});
});
