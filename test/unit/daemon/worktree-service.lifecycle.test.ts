import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Result as Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	isConduitWorktreePath,
	makeWorktreeLive,
	ownedWorktreePath,
	worktreesRoot,
} from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { inspectSessionWorktree } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { worktreeFixture } from "./worktree-service-fixture.js";

// Real git subprocesses: tests measured 3-9 s each under CPU contention.
describe("daemon Worktree service", { timeout: 30_000 }, () => {
	const context = worktreeFixture();
	const {
		actualGit,
		git,
		repositoryState,
		secondGitFolder,
		createEffect,
		creationError,
		gitWrapper,
		runRealGit,
		assertUnchanged,
	} = context;

	const recreateEffect = (
		directory?: string,
		options?: { gitExecutable?: string; gitTimeoutMs?: number },
	) =>
		Effect.flatMap(WorktreeServiceTag, (service) =>
			service.recreate(context.folder, directory),
		).pipe(Effect.provide(makeWorktreeLive(context.configDir, options)));

	const recoveryError = async (
		directory?: string,
		options?: { gitExecutable?: string; gitTimeoutMs?: number },
	) => {
		const result = await Effect.runPromise(
			Effect.result(recreateEffect(directory, options)),
		);
		if (Either.isSuccess(result))
			throw new Error("Expected recreation to fail");
		return result.failure;
	};

	const inspectMissing = (directory?: string) =>
		Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.inspectMissing(context.folder, directory),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);

	it.each([
		"main",
		"master",
	])("inspects a merge into local %s while origin is stale, with and without an upstream", async (local) => {
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		git("branch", "published");
		if (local === "master") git("branch", "master");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		const inspect = Effect.flatMap(WorktreeServiceTag, (service) =>
			service.inspectRemoval(context.folder, owned),
		).pipe(Effect.provide(makeWorktreeLive(context.configDir)));
		const unmerged = [
			"Unpushed commits",
			"Commits not merged into the default branch",
		];
		expect(await Effect.runPromise(inspect)).toEqual(unmerged);
		git("branch", "--set-upstream-to=published", "owned");
		expect(await Effect.runPromise(inspect)).toEqual(unmerged);
		git("checkout", "-q", local);
		git("merge", "--ff-only", "-q", "owned");
		expect(git("rev-parse", "origin/main")).toBe(owned.head);
		expect(await Effect.runPromise(inspect)).toEqual([]);
		git("branch", "--unset-upstream", "owned");
		expect(await Effect.runPromise(inspect)).toEqual([]);
		git("reset", "--hard", owned.head);
		expect(await Effect.runPromise(inspect)).toEqual(unmerged);
	});

	it.each([
		true,
		false,
	])("ignores a dangling origin HEAD during removal inspection when a local default exists: %s", async (hasLocal) => {
		git(
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/missing",
		);
		if (!hasLocal) git("branch", "-m", "topic");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		if (hasLocal) git("merge", "--ff-only", "-q", "owned");
		const reasons = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.inspectRemoval(context.folder, owned),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(reasons).toEqual(
			hasLocal ? [] : ["Unpushed commits", "Unknown default branch"],
		);
	});

	it.each([
		["main", false],
		["main", true],
		["master", false],
		["master", true],
	] as const)("removes a worktree merged only into local %s and deletes its branch when detached is %s", async (local, detached) => {
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		if (local === "master") git("branch", "master");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		const tip = git("rev-parse", "owned");
		git("checkout", "-q", local);
		git("merge", "--ff-only", "-q", "owned");
		if (detached) git("-C", owned.path, "checkout", "-q", "--detach");
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(context.folder, owned),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(existsSync(owned.path)).toBe(false);
		expect(git("for-each-ref", "--format=%(refname)", "refs/heads/owned")).toBe(
			"",
		);
		expect(git("rev-parse", local)).toBe(tip);
		expect(git("rev-parse", "origin/main")).toBe(owned.head);
	});

	// Checkout cleanup retains the owned ref for recovery. A later deletion must
	// still prove ownership, merge safety and usage before deleting that ref.
	it("deletes its merged branch after checkout-only cleanup", async () => {
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		const tip = git("rev-parse", "owned");
		git("merge", "--ff-only", "-q", "owned");
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeServiceTag;
				expect(
					yield* service.removeCheckout(
						context.folder,
						owned,
						"uncommitted-changes",
						tip,
						Effect.succeed(false),
					),
				).toBeUndefined();
				expect(existsSync(owned.path)).toBe(false);
				expect(git("rev-parse", "owned")).toBe(tip);
				yield* service.remove(context.folder, owned);
			}).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(git("for-each-ref", "--format=%(refname)", "refs/heads/owned")).toBe(
			"",
		);
		expect(git("rev-parse", "main")).toBe(tip);
	});

	// An absent checkout must not bypass unmerged/default, ownership, use or path
	// protection. Only a currently unused, proven merged owned ref is removable.
	it.each([
		"unmerged",
		"unknown-default",
		"in-use",
		"unproven-ref",
		"other-checkout",
		"wrong-base",
		"wrong-path",
	])("preserves the branch after checkout cleanup when protection is %s", async (protection) => {
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		const tip = git("rev-parse", "owned");
		if (protection !== "unmerged") git("merge", "--ff-only", "-q", "owned");
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.removeCheckout(
					context.folder,
					owned,
					"uncommitted-changes",
					tip,
					Effect.succeed(false),
				),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(existsSync(owned.path)).toBe(false);
		if (protection === "unknown-default") git("branch", "-m", "main", "topic");
		if (protection === "unproven-ref") {
			git("branch", "-D", "owned");
			git("branch", "owned", tip);
		}
		if (protection === "other-checkout")
			git("worktree", "add", join(context.fixture, "other"), "owned");
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(
					context.folder,
					{
						...owned,
						...(protection === "wrong-base" ? { head: tip } : {}),
						...(protection === "wrong-path"
							? { path: join(context.fixture, "not-owned") }
							: {}),
					},
					Effect.succeed(protection === "in-use"),
				),
			).pipe(
				Effect.result,
				Effect.provide(makeWorktreeLive(context.configDir)),
			),
		);
		if (protection === "in-use" || protection === "wrong-path") {
			if (Either.isSuccess(result))
				throw new Error("Expected protected removal to fail");
			expect(result.failure.reason).toBe(
				protection === "in-use" ? "branch-in-use" : "not-owned",
			);
		} else expect(Either.isSuccess(result)).toBe(true);
		expect(git("rev-parse", "owned")).toBe(tip);
	});

	it.each([
		false,
		true,
	])("preserves unmerged commits during removal when detached is %s", async (detached) => {
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		const tip = git("rev-parse", "owned");
		if (detached) git("-C", owned.path, "checkout", "-q", "--detach");
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(context.folder, owned),
			).pipe(
				Effect.result,
				Effect.provide(makeWorktreeLive(context.configDir)),
			),
		);
		expect(Either.isFailure(result)).toBe(detached);
		expect(existsSync(owned.path)).toBe(detached);
		expect(git("rev-parse", "owned")).toBe(tip);
	});

	it.each([
		"dirty",
		"in-use",
	])("keeps a locally merged worktree when it is %s", async (protection) => {
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		git("merge", "--ff-only", "-q", "owned");
		if (protection === "dirty")
			writeFileSync(join(owned.path, "tracked.txt"), "dirty\n");
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(
					context.folder,
					owned,
					Effect.succeed(protection === "in-use"),
				),
			).pipe(
				Effect.result,
				Effect.provide(makeWorktreeLive(context.configDir)),
			),
		);
		if (Either.isSuccess(result)) throw new Error("Expected removal to fail");
		expect(result.failure.message).toContain(
			protection === "dirty" ? "uncommitted changes" : "another session",
		);
		expect(existsSync(owned.path)).toBe(true);
		expect(git("rev-parse", "owned")).toBe(git("rev-parse", "main"));
	});

	it.each([
		["main", false],
		["main", true],
		["master", false],
		["master", true],
		["trunk", false],
		["trunk", true],
	] as const)("preserves a session branch renamed to default branch %s during removal after cleanup=%s", async (branch, cleaned) => {
		git("branch", "-m", "topic");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		git("-C", owned.path, "branch", "-m", branch);
		const tip = git("rev-parse", branch);
		git("update-ref", "refs/remotes/origin/trunk", tip);
		git(
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeServiceTag;
				const renamed = { ...owned, branchName: branch };
				if (cleaned)
					expect(
						yield* service.removeCheckout(
							context.folder,
							renamed,
							"uncommitted-changes",
							tip,
							Effect.succeed(false),
						),
					).toBeUndefined();
				yield* service.remove(context.folder, renamed);
			}).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(existsSync(owned.path)).toBe(false);
		expect(git("rev-parse", branch)).toBe(tip);
	});

	it.each([
		false,
		true,
	])("preserves the session branch if local main resets after the merge proof and cleanup=%s", async (cleaned) => {
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		writeFileSync(join(owned.path, "feature.txt"), "feature\n");
		git("-C", owned.path, "add", ".");
		git("-C", owned.path, "commit", "-qm", "Feature");
		const tip = git("rev-parse", "owned");
		git("merge", "--ff-only", "-q", "owned");
		if (cleaned)
			await Effect.runPromise(
				Effect.flatMap(WorktreeServiceTag, (service) =>
					service.removeCheckout(
						context.folder,
						owned,
						"uncommitted-changes",
						tip,
						Effect.succeed(false),
					),
				).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
			);
		const resettingGit = gitWrapper(`
if (args.includes("update-ref") && args.includes("--stdin")) {
  spawnSync(${JSON.stringify(actualGit)}, ["-C", ${JSON.stringify(context.repository)}, "update-ref", "refs/heads/main", ${JSON.stringify(owned.head)}]);
}
${runRealGit}
process.exit(result.status ?? 1);
`);
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(context.folder, owned),
			).pipe(
				Effect.result,
				Effect.provide(
					makeWorktreeLive(context.configDir, { gitExecutable: resettingGit }),
				),
			),
		);
		if (Either.isSuccess(result))
			throw new Error("Expected deletion transaction to fail");
		expect(result.failure.message).toContain("refs/heads/main");
		expect(existsSync(owned.path)).toBe(false);
		expect(git("rev-parse", "owned")).toBe(tip);
		expect(git("rev-parse", "main")).toBe(owned.head);
	});

	it("preserves a newer owned branch tip racing deletion after checkout cleanup", async () => {
		const created = await Effect.runPromise(createEffect("owned"));
		const owned = created.ownership[0];
		if (!owned) throw new Error("Missing ownership");
		const tip = git("rev-parse", "owned");
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.removeCheckout(
					context.folder,
					owned,
					"uncommitted-changes",
					tip,
					Effect.succeed(false),
				),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		const newer = git(
			"commit-tree",
			`${tip}^{tree}`,
			"-p",
			tip,
			"-m",
			"Concurrent work",
		);
		const advancingGit = gitWrapper(`
if (args.includes("update-ref") && args.includes("--stdin")) {
  spawnSync(${JSON.stringify(actualGit)}, ["-C", ${JSON.stringify(context.repository)}, "update-ref", "refs/heads/owned", ${JSON.stringify(newer)}]);
}
${runRealGit}
process.exit(result.status ?? 1);
`);
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(context.folder, owned),
			).pipe(
				Effect.result,
				Effect.provide(
					makeWorktreeLive(context.configDir, { gitExecutable: advancingGit }),
				),
			),
		);
		if (Either.isSuccess(result))
			throw new Error("Expected deletion transaction to fail");
		expect(result.failure.message).toContain("refs/heads/owned");
		expect(git("rev-parse", "owned")).toBe(newer);
		expect(git("rev-parse", "main")).toBe(tip);
	});

	it("inspects every mapped folder while skipping Git for each present checkout", async () => {
		const extra = secondGitFolder();
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeServiceTag;
				const created = yield* service.create([context.folder, extra]);
				const inspect = () =>
					inspectSessionWorktree(
						{
							id: context.folder.sessionId,
							workspace: {
								origin: "conduit",
								cause: "launch",
								worktrees: created.worktrees,
							},
						},
						{
							projectDir: context.folder.path,
							slug: context.folder.projectSlug,
						},
					);
				const calls = vi.spyOn(service, "inspectMissing");
				expect(yield* inspect()).toBeUndefined();
				expect(calls).not.toHaveBeenCalled();
				const path = created.worktrees[extra.path] ?? "";
				rmSync(path, { recursive: true });
				expect(yield* inspect()).toMatchObject({
					path,
					canRecreate: true,
					folders: [{ folder: extra.path, path }],
				});
				expect(calls).toHaveBeenCalledTimes(1);
				expect(calls).toHaveBeenCalledWith(
					extra,
					path,
					[context.folder.path, extra.path],
					undefined,
				);
			}).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
	});

	it("reports both missing folders and a deleted extra branch blocks the whole recovery", async () => {
		const extra = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [context.folder, extra]),
		);
		for (const path of Object.values(created.worktrees))
			rmSync(path, { recursive: true });
		git(
			"-C",
			extra.path,
			"update-ref",
			"-d",
			`refs/heads/${created.branchName}`,
		);
		const state = await Effect.runPromise(
			inspectSessionWorktree(
				{
					id: context.folder.sessionId,
					workspace: {
						origin: "conduit",
						cause: "launch",
						worktrees: created.worktrees,
					},
				},
				{ projectDir: context.folder.path, slug: context.folder.projectSlug },
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(state?.folders?.map(({ folder }) => folder)).toEqual([
			context.folder.path,
			extra.path,
		]);
		expect(state).toMatchObject({
			canRecreate: false,
			reason: "branch-missing",
		});
	});

	it("recreates a missing checkout from the registered renamed branch without changing its ref", async () => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		git("-C", path, "branch", "-m", "renamed-session");
		writeFileSync(join(path, "tracked.txt"), "branch commit\n");
		git("-C", path, "commit", "-qam", "Session commit");
		const head = git("rev-parse", "renamed-session");
		writeFileSync(join(context.repository, "tracked.txt"), "main edit\n");
		const main = git("status", "--porcelain");
		rmSync(path, { recursive: true });
		expect(await inspectMissing()).toEqual({
			path,
			branch: "renamed-session",
			canRecreate: true,
		});
		expect(await Effect.runPromise(recreateEffect())).toBe(path);
		expect(await inspectMissing()).toBeUndefined();
		expect(git("-C", path, "branch", "--show-current")).toBe("renamed-session");
		expect(git("-C", path, "rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe(
			"branch commit\n",
		);
		expect(git("status", "--porcelain")).toBe(main);
	});

	it("refuses a deleted branch and reports why recreation is unavailable", async () => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		rmSync(path, { recursive: true });
		git("update-ref", "-d", `refs/heads/${created.branchName}`);
		const before = repositoryState();
		expect(await inspectMissing()).toEqual({
			path,
			branch: created.branchName,
			canRecreate: false,
			reason: "branch-missing",
		});
		expect((await recoveryError()).reason).toBe("branch-missing");
		assertUnchanged(before);
	});

	it("does not guess a branch after the missing worktree registration was pruned", async () => {
		const created = await Effect.runPromise(createEffect());
		rmSync(created.worktrees[context.repository] ?? "", { recursive: true });
		git("worktree", "prune");
		const before = repositoryState();
		expect((await inspectMissing())?.reason).toBe("branch-unknown");
		expect((await recoveryError()).reason).toBe("branch-unknown");
		assertUnchanged(before);
	});

	it("refuses a recovery branch checked out in another live worktree", async () => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		rmSync(path, { recursive: true });
		const other = join(context.fixture, "other-checkout");
		git("worktree", "add", "--force", other, created.branchName);
		const before = repositoryState();
		expect(await inspectMissing()).toEqual({
			path,
			branch: created.branchName,
			canRecreate: false,
			reason: "branch-in-use",
		});
		expect((await recoveryError()).reason).toBe("branch-in-use");
		assertUnchanged(before);
		expect(git("-C", other, "branch", "--show-current")).toBe(
			created.branchName,
		);
	});

	it.each([
		"directory",
		"file",
		"symlink",
	])("preserves an occupied recovery target: %s", async (kind) => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		rmSync(path, { recursive: true });
		if (kind === "directory") {
			mkdirSync(path);
			writeFileSync(join(path, "keep.txt"), "keep\n");
		} else if (kind === "file") writeFileSync(path, "keep\n");
		else symlinkSync(context.repository, path);
		const before = repositoryState();
		expect((await inspectMissing())?.canRecreate).toBe(true);
		expect((await recoveryError()).reason).toBe("target-exists");
		expect(repositoryState()).toEqual(before);
		expect(existsSync(path)).toBe(true);
		if (kind !== "symlink")
			expect(
				readFileSync(
					kind === "directory" ? join(path, "keep.txt") : path,
					"utf8",
				),
			).toBe("keep\n");
		expect(readFileSync(join(context.repository, "tracked.txt"), "utf8")).toBe(
			"committed\n",
		);
	});

	it.each([
		false,
		true,
	])("preserves the branch when Git recreation fails, after add=%s", async (afterAdd) => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		const head = git("rev-parse", created.branchName);
		rmSync(path, { recursive: true });
		const executable = gitWrapper(
			`if (args.includes("worktree") && args.includes("add")) { ${afterAdd ? runRealGit : ""} console.error("forced recreation failure"); process.exit(42); }\n${runRealGit}\nprocess.exit(result.status ?? 1);`,
		);
		const error = await recoveryError(undefined, { gitExecutable: executable });
		expect(error.reason).toBe("git-failed");
		expect(error.message).toContain("forced recreation failure");
		expect(git("rev-parse", created.branchName)).toBe(head);
		expect(git("status", "--porcelain")).toBe("");
		expect(existsSync(path)).toBe(false);
		expect((await inspectMissing())?.canRecreate).toBe(true);
	});

	it("preserves the winning checkout when two recreations race", async () => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		rmSync(path, { recursive: true });
		const results = await Promise.all([
			Effect.runPromise(Effect.result(recreateEffect())),
			Effect.runPromise(Effect.result(recreateEffect())),
		]);
		expect(results.filter(Either.isSuccess)).toHaveLength(1);
		expect(
			results.filter(Either.isFailure).map(({ failure }) => failure.reason),
		).toEqual(["target-exists"]);
		expect(git("-C", path, "branch", "--show-current")).toBe(
			created.branchName,
		);
	});

	it("recreates a repository subdirectory at its original mapping", async () => {
		context.folder = {
			...context.folder,
			path: join(context.repository, "app"),
		};
		const created = await Effect.runPromise(createEffect());
		const directory = created.worktrees[context.folder.path] ?? "";
		rmSync(ownedWorktreePath(context.configDir, context.folder), {
			recursive: true,
		});
		expect(await Effect.runPromise(recreateEffect(directory))).toBe(directory);
		expect(readFileSync(join(directory, "app.txt"), "utf8")).toBe(
			"app committed\n",
		);
	});

	it("keeps and recreates the isolated subfolder when its main copy is missing", async () => {
		context.folder = {
			...context.folder,
			path: join(context.repository, "app"),
		};
		const created = await Effect.runPromise(createEffect());
		const directory = created.worktrees[context.folder.path] ?? "";
		rmSync(context.folder.path, { recursive: true });
		expect(await inspectMissing(directory)).toBeUndefined();
		const main = git("status", "--porcelain");
		rmSync(ownedWorktreePath(context.configDir, context.folder), {
			recursive: true,
		});
		expect((await inspectMissing(directory))?.canRecreate).toBe(true);
		expect(await Effect.runPromise(recreateEffect(directory))).toBe(directory);
		expect(readFileSync(join(directory, "app.txt"), "utf8")).toBe(
			"app committed\n",
		);
		expect(git("status", "--porcelain")).toBe(main);
		expect(existsSync(context.folder.path)).toBe(false);
	});

	it("refuses a path outside the owned location", async () => {
		const before = repositoryState();
		expect((await recoveryError(join(context.fixture, "unowned"))).reason).toBe(
			"not-owned",
		);
		assertUnchanged(before);
	});

	it("rejects an empty folder list before doing any work", async () => {
		const before = repositoryState();
		expect((await creationError(undefined, undefined, [])).reason).toBe(
			"unsupported-project",
		);
		assertUnchanged(before);
	});

	it("rejects a project with no git folders without creating anything", async () => {
		const scratch = {
			...context.folder,
			path: join(context.fixture, "scratch"),
		};
		mkdirSync(scratch.path);
		expect((await creationError(undefined, undefined, [scratch])).reason).toBe(
			"unsupported-project",
		);
		expect(existsSync(worktreesRoot(context.configDir))).toBe(false);
	});

	it("guards the root and descendants, including symlink aliases and absent children", () => {
		const root = worktreesRoot(context.configDir);
		mkdirSync(root);
		const alias = join(context.fixture, "worktree-alias");
		symlinkSync(root, alias);
		expect(isConduitWorktreePath(context.configDir, root)).toBe(true);
		expect(
			isConduitWorktreePath(
				context.configDir,
				join(root, "not-created", "child"),
			),
		).toBe(true);
		expect(isConduitWorktreePath(context.configDir, alias)).toBe(true);
		expect(
			isConduitWorktreePath(
				context.configDir,
				join(alias, "not-created", "child"),
			),
		).toBe(true);
		expect(isConduitWorktreePath(context.configDir, `${root}-elsewhere`)).toBe(
			false,
		);
		expect(isConduitWorktreePath(context.configDir, context.repository)).toBe(
			false,
		);
	});

	it("refuses outward symlinks beneath both root spellings", () => {
		const root = worktreesRoot(context.configDir);
		mkdirSync(root);
		const outward = join(root, "outward");
		symlinkSync(context.repository, outward);
		expect(isConduitWorktreePath(context.configDir, outward)).toBe(true);
		expect(isConduitWorktreePath(context.configDir, join(outward, "app"))).toBe(
			true,
		);
		const alias = join(context.fixture, "config-alias");
		symlinkSync(context.configDir, alias);
		expect(
			isConduitWorktreePath(alias, join(alias, "worktrees", "outward")),
		).toBe(true);
		expect(isConduitWorktreePath(alias, outward)).toBe(true);
	});
});
