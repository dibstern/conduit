import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as WorktreeLayer from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import {
	type WorktreeService,
	WorktreeServiceTag,
} from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { readSessionWorktreeOwnership } from "../../../src/lib/domain/relay/Services/session-worktree-deletion.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { createProjectRelayLayers } from "../../../src/lib/relay/project-relay-layers.js";
import { claudeSdk } from "../../helpers/fake-claude-process-sdk.js";

// Failure modes: the standalone workspace captures no worktree service; supplying
// it constructs a second instance; a borrowed service is replaced by a local one.
describe("standalone SessionWorkspace composition", () => {
	it.each([
		false,
		true,
	])("renames through its construction-time worktree service (borrowed: %s)", async (borrowed) => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-standalone-workspace-")),
		);
		const projectDir = join(root, "project");
		const configDir = join(root, "config");
		mkdirSync(projectDir);
		mkdirSync(configDir);
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
		const owner = borrowed
			? ManagedRuntime.make(WorktreeLayer.makeWorktreeLive(configDir))
			: undefined;
		const worktrees = await owner?.runPromise(WorktreeServiceTag);
		const httpServer = createServer();
		const { relayManagedRuntime } = createProjectRelayLayers({
			config: {
				httpServer,
				projectDir,
				configDir,
				slug: "standalone",
				persistenceDbPath: join(configDir, "events.db"),
				claudeSdk,
				log: createSilentLogger(),
				publishGlobalSetting: () => Effect.void,
				...(worktrees
					? { worktreeContext: Context.make(WorktreeServiceTag, worktrees) }
					: {}),
			},
			onBackgroundWorkChanged: () => {},
			getWsHandler: () => undefined,
		});
		const evidence: Record<string, unknown> = { borrowed };
		try {
			const context = await relayManagedRuntime.context();
			const service = Option.getOrThrow(
				Context.getOption(context, WorktreeServiceTag),
			);
			expect([...constructed]).toEqual([service]);
			expect(construct).toHaveBeenCalledOnce();
			if (worktrees) expect(service).toBe(worktrees);
			const rename = vi.spyOn(service, "renameBranch");
			const sessionId = "standalone-rename";
			const created = await Effect.runPromise(
				service.create([
					{ path: projectDir, projectSlug: "standalone", sessionId },
				]),
			);
			await relayManagedRuntime.runPromise(
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
			const workspace = Context.get(context, SessionWorkspaceTag);
			evidence["before"] = created;
			// Run the retained service without a caller context or worktree fallback.
			await Effect.runPromise(
				workspace.renameBranch(sessionId, "renamed-standalone"),
			);
			expect(rename).toHaveBeenCalledExactlyOnceWith(
				created.ownership,
				"renamed-standalone",
			);
			const ownership = await relayManagedRuntime.runPromise(
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
			await relayManagedRuntime.dispose();
			await owner?.dispose();
			vi.restoreAllMocks();
			evidence["worktreeInstances"] = constructed.size;
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-10-3-standalone-workspace-${borrowed ? "borrowed" : "owned"}.json`,
				JSON.stringify(evidence, null, 2),
			);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
