import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as WorktreeLayer from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import {
	type WorktreeService,
	WorktreeServiceTag,
} from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/project-services/Services/session-workspace.js";
import { readSessionWorktreeOwnership } from "../../../src/lib/domain/project-services/Services/session-worktree-deletion.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createDaemonProject } from "../../helpers/in-process-daemon.js";

// Failure modes: the project's workspace captures no worktree service; the
// project constructs a second instance instead of borrowing the daemon's.
describe("daemon project SessionWorkspace composition", () => {
	it("renames through the daemon's one worktree service", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-standalone-workspace-")),
		);
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		const git = (directory: string, ...args: string[]) =>
			execFileSync("git", ["-C", directory, ...args], {
				encoding: "utf8",
				stdio: "pipe",
			}).trim();
		git(projectDir, "init", "-b", "main");
		git(
			projectDir,
			"-c",
			"user.name=Workspace test",
			"-c",
			"user.email=workspace@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Fixture",
		);
		const constructed = new Set<WorktreeService>();
		const makeWorktreeLive = WorktreeLayer.makeWorktreeLive;
		const construct = vi
			.spyOn(WorktreeLayer, "makeWorktreeLive")
			.mockImplementation((...args) =>
				makeWorktreeLive(...args).pipe(
					Layer.tap((context) =>
						Effect.sync(() => {
							constructed.add(Context.get(context, WorktreeServiceTag));
						}),
					),
				),
			);
		const relay = await createDaemonProject("chat-simple", {
			slug: "standalone",
			projectDir,
		});
		const evidence: Record<string, unknown> = { borrowed: true };
		try {
			const service = await relay.run(WorktreeServiceTag);
			expect([...constructed]).toEqual([service]);
			expect(construct).toHaveBeenCalledOnce();
			const rename = vi.spyOn(service, "renameBranch");
			const sessionId = "standalone-rename";
			const created = await Effect.runPromise(
				service.create([
					{ path: projectDir, projectSlug: "standalone", sessionId },
				]),
			);
			await relay.run(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					yield* commit([
						canonicalEvent("session.created", sessionId, {
							sessionId,
							provider: "claude",
							title: "Standalone rename",
						}),
						canonicalEvent("session.workspace_changed", sessionId, {
							sessionId,
							cause: "launch",
							origin: "conduit",
							worktrees: created.worktrees,
							ownership: created.ownership,
						}),
					]);
				}),
			);
			const workspace = await relay.run(SessionWorkspaceTag);
			evidence["before"] = created;
			// Run the retained service without a caller context or worktree fallback.
			await Effect.runPromise(
				workspace.renameBranch(sessionId, "renamed-standalone"),
			);
			expect(rename).toHaveBeenCalledExactlyOnceWith(
				created.ownership,
				"renamed-standalone",
			);
			const ownership = await relay.run(
				readSessionWorktreeOwnership(sessionId, false),
			);
			expect(ownership).toEqual(
				created.ownership.map((owned) => ({
					...owned,
					branchName: "renamed-standalone",
				})),
			);
			for (const owned of ownership)
				expect(git(owned.path, "branch", "--show-current")).toBe(
					"renamed-standalone",
				);
			expect(await Effect.runPromise(workspace.get(sessionId))).toBe(
				created.worktrees[projectDir],
			);
			evidence["after"] = ownership;
			evidence["result"] = "passed";
		} catch (error) {
			evidence["result"] = "failed";
			evidence["error"] = String(error);
			throw error;
		} finally {
			await relay.stop();
			vi.restoreAllMocks();
			evidence["worktreeInstances"] = constructed.size;
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-10-3-standalone-workspace-borrowed.json",
				JSON.stringify(evidence, null, 2),
			);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
