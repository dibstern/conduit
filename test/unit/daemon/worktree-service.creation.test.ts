import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Effect, Result as Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	makeWorktreeLive,
	ownedWorktreePath,
	worktreesRoot,
} from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import { WorktreeServiceTag } from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { worktreeFixture } from "./worktree-service-fixture.js";

describe("daemon Worktree service", () => {
	const context = worktreeFixture();
	const {
		git,
		repositoryState,
		secondGitFolder,
		createEffect,
		creationError,
		gitWrapper,
		assertUnchanged,
	} = context;

	it.each([
		"invalid",
		"taken",
		"missing",
		"head",
	] as const)("branch rename rejects %s before changing either repository", async (failure) => {
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect("owned", undefined, [context.folder, second]),
		);
		const secondPath = created.worktrees[second.path];
		if (!secondPath) throw new Error("Missing second worktree");
		if (failure === "taken") git("-C", second.path, "branch", "renamed");
		if (failure === "missing") rmSync(secondPath, { recursive: true });
		if (failure === "head") git("-C", secondPath, "switch", "--detach");
		const before = [repositoryState(), repositoryState(second.path)];
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(
					created.ownership,
					failure === "invalid" ? "bad name" : "renamed",
				),
			).pipe(
				Effect.result,
				Effect.provide(makeWorktreeLive(context.configDir)),
			),
		);
		if (Either.isSuccess(result)) throw new Error("Expected rename to fail");
		expect(result.failure).toMatchObject({
			folder: failure === "invalid" ? context.repository : second.path,
			reason: {
				invalid: "invalid-name",
				taken: "already-exists",
				missing: "worktree-missing",
				head: "head-mismatch",
			}[failure],
		});
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
	});

	it("renames a shared checkout once and treats the current name as a no-op", async () => {
		const created = await Effect.runPromise(
			createEffect("owned", undefined, [
				context.folder,
				{ ...context.folder, path: join(context.repository, "app") },
			]),
		);
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(created.ownership, "renamed"),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		const ownership = created.ownership.map((owned) => ({
			...owned,
			branchName: "renamed",
		}));
		const before = repositoryState();
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(ownership, "renamed"),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(repositoryState()).toEqual(before);
		expect(git("branch", "--list", "owned")).toBe("");
		expect(git("branch", "--list", "renamed")).toContain("renamed");
	});

	it.each([
		undefined,
		"feature/together",
	])("creates the same branch in both git folders, requested=%s", async (branch) => {
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(branch, undefined, [context.folder, second]),
		);
		expect(Object.keys(created.worktrees)).toEqual([
			context.repository,
			second.path,
		]);
		expect(created.ownership).toHaveLength(2);
		for (const entry of [context.folder, second]) {
			const path = created.worktrees[entry.path] ?? "";
			expect(git("-C", path, "branch", "--show-current")).toBe(
				created.branchName,
			);
			expect(git("-C", path, "rev-parse", "HEAD")).toBe(
				git("-C", entry.path, "rev-parse", "HEAD"),
			);
		}
		if (branch) expect(created.branchName).toBe(branch);
	});

	it.each([
		"siblings",
		"nested",
	])("maps %s folders of one repository into the same owned checkout", async (layout) => {
		const app = { ...context.folder, path: join(context.repository, "app") };
		const api = { ...context.folder, path: join(context.repository, "api") };
		mkdirSync(api.path);
		writeFileSync(join(api.path, "api.txt"), "api committed\n");
		git("add", ".");
		git("commit", "-qm", "Add API");
		const entries = layout === "siblings" ? [app, api] : [context.folder, app];
		const before = repositoryState();
		const created = await Effect.runPromise(
			createEffect("feature/together", undefined, entries),
		);
		expect(created.ownership).toHaveLength(1);
		const checkout = created.ownership[0]?.path ?? "";
		for (const entry of entries) {
			const path = created.worktrees[entry.path] ?? "";
			expect(path).toBe(
				entry.path === context.repository
					? checkout
					: join(checkout, entry.path === app.path ? "app" : "api"),
			);
			expect(git("-C", path, "branch", "--show-current")).toBe(
				"feature/together",
			);
		}
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.rollback(created),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		expect(repositoryState()).toEqual(before);
		expect(existsSync(checkout)).toBe(false);
	});

	it("rejects different base commits for folders sharing a repository", async () => {
		const extra = {
			...context.folder,
			path: join(context.fixture, "different-base"),
		};
		git("worktree", "add", "-b", "different", extra.path);
		writeFileSync(join(extra.path, "tracked.txt"), "different base\n");
		git("-C", extra.path, "commit", "-qam", "Different base");
		const before = repositoryState();
		const error = await creationError("feature/together", undefined, [
			context.folder,
			extra,
		]);
		expect(error.reason).toBe("unsupported-project");
		expect(error.message).toContain("different base commits");
		expect(repositoryState()).toEqual(before);
		for (const entry of [context.folder, extra])
			expect(existsSync(ownedWorktreePath(context.configDir, entry))).toBe(
				false,
			);
	});

	it("skips non-git folders, including a non-git primary", async () => {
		const scratch = {
			...context.folder,
			path: join(context.fixture, "scratch"),
		};
		mkdirSync(scratch.path);
		writeFileSync(join(scratch.path, "keep.txt"), "shared\n");
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [scratch, context.folder, second]),
		);
		expect(Object.keys(created.worktrees)).toEqual([
			context.repository,
			second.path,
		]);
		expect(created.ownership).toHaveLength(2);
		expect(existsSync(ownedWorktreePath(context.configDir, scratch))).toBe(
			false,
		);
		expect(readFileSync(join(scratch.path, "keep.txt"), "utf8")).toBe(
			"shared\n",
		);
	});

	it("preserves an explicit branch that exists only in the second repository", async () => {
		const second = secondGitFolder();
		git("-C", second.path, "branch", "feature/taken");
		const before = [repositoryState(), repositoryState(second.path)];
		const error = await creationError("feature/taken", undefined, [
			context.folder,
			second,
		]);
		expect(error.reason).toBe("branch-exists");
		expect(error.path).toBe(second.path);
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
		for (const entry of [context.folder, second])
			expect(existsSync(ownedWorktreePath(context.configDir, entry))).toBe(
				false,
			);
	});

	it("chooses a generated branch free in every repository namespace", async () => {
		const second = secondGitFolder();
		git("-C", second.path, "branch", "conduit");
		git("branch", "conduit-session-trace-sessio");
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [context.folder, second]),
		);
		expect(created.branchName).toBe("conduit-session-trace-sessio-2");
		for (const entry of [context.folder, second])
			expect(
				git(
					"-C",
					created.worktrees[entry.path] ?? "",
					"branch",
					"--show-current",
				),
			).toBe(created.branchName);
	});

	it("creates under the daemon root from the current branch and can roll it back", async () => {
		const before = repositoryState();
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository];
		expect(path).toBe(ownedWorktreePath(context.configDir, context.folder));
		expect(
			path?.startsWith(
				`${worktreesRoot(context.configDir)}/project/trace-session/`,
			),
		).toBe(true);
		expect(created.branchName).toMatch(/^conduit\/session-trace-sessio/);
		expect(git("rev-parse", created.branchName)).toBe(git("rev-parse", "HEAD"));
		expect(readFileSync(join(path ?? "", "tracked.txt"), "utf8")).toBe(
			"committed\n",
		);
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.rollback(created),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		assertUnchanged(before);
	});

	it("uses the explicit local base only for its folder", async () => {
		const baseHead = git("rev-parse", "HEAD");
		git("branch", "feature/base");
		writeFileSync(
			join(context.repository, "tracked.txt"),
			"current branch commit\n",
		);
		git("commit", "-qam", "Current branch advances");
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [context.folder, second], {
				[context.repository]: "feature/base",
			}),
		);
		expect(
			git(
				"-C",
				created.worktrees[context.repository] ?? "",
				"rev-parse",
				"HEAD",
			),
		).toBe(baseHead);
		expect(
			git("-C", created.worktrees[second.path] ?? "", "rev-parse", "HEAD"),
		).toBe(git("-C", second.path, "rev-parse", "HEAD"));
		expect(git("rev-parse", "HEAD")).not.toBe(baseHead);
	});

	it.each([
		"missing",
		"release",
		"origin/main",
		"HEAD",
		"main~1",
		"main^{commit}",
		"refs/heads/main",
	])("rejects the non-local base %s before creating anything in either folder", async (base) => {
		git("tag", "release");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		const second = secondGitFolder();
		const before = repositoryState();
		const beforeSecond = repositoryState(second.path);
		const error = await creationError(
			undefined,
			undefined,
			[second, context.folder],
			{
				[context.repository]: base,
			},
		);
		expect(error.reason).toBe("invalid-branch");
		expect(error.message).toContain(base);
		assertUnchanged(before);
		expect(repositoryState(second.path)).toEqual(beforeSecond);
		expect(existsSync(ownedWorktreePath(context.configDir, second))).toBe(
			false,
		);
	});

	it("uses an explicit local base even when the source HEAD is detached", async () => {
		git("checkout", "-q", "--detach");
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [context.folder], {
				[context.repository]: "main",
			}),
		);
		expect(
			git(
				"-C",
				created.worktrees[context.repository] ?? "",
				"rev-parse",
				"HEAD",
			),
		).toBe(git("rev-parse", "main"));
	});

	it("rejects an explicit base for a non-git folder", async () => {
		const scratch = {
			...context.folder,
			path: join(context.fixture, "scratch"),
		};
		mkdirSync(scratch.path);
		const before = repositoryState();
		const error = await creationError(
			undefined,
			undefined,
			[context.folder, scratch],
			{
				[scratch.path]: "main",
			},
		);
		expect(error.reason).toBe("unsupported-project");
		assertUnchanged(before);
	});

	it("preserves an existing explicit branch and its existing checkout", async () => {
		const existing = join(context.fixture, "existing");
		git("worktree", "add", "-qb", "taken", existing);
		writeFileSync(join(existing, "keep.txt"), "keep\n");
		const before = repositoryState();
		const error = await creationError("taken");
		expect(error.reason).toBe("branch-exists");
		expect(error.message).toContain("taken");
		expect(readFileSync(join(existing, "keep.txt"), "utf8")).toBe("keep\n");
		assertUnchanged(before);
	});

	it.each([
		"bad name",
		"bad..name",
		"-bad",
		"@{-1}",
	])("rejects the invalid branch %s without changing the repository", async (name) => {
		const before = repositoryState();
		expect((await creationError(name)).reason).toBe("invalid-branch");
		assertUnchanged(before);
	});

	it("starts at committed HEAD when the source has staged, unstaged and untracked edits", async () => {
		writeFileSync(join(context.repository, "tracked.txt"), "staged\n");
		git("add", "tracked.txt");
		writeFileSync(join(context.repository, "tracked.txt"), "unstaged\n");
		writeFileSync(join(context.repository, "untracked.txt"), "untracked\n");
		const before = git("status", "--porcelain");
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[context.repository] ?? "";
		expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("committed\n");
		expect(existsSync(join(path, "untracked.txt"))).toBe(false);
		expect(git("-C", path, "status", "--porcelain")).toBe("");
		expect(git("status", "--porcelain")).toBe(before);
		expect(readFileSync(join(context.repository, "tracked.txt"), "utf8")).toBe(
			"unstaged\n",
		);
	});

	it("rejects a detached HEAD without creating a branch or directory", async () => {
		git("checkout", "-q", "--detach");
		const before = repositoryState();
		const error = await creationError();
		expect(error.reason).toBe("detached-head");
		expect(error.message).toContain("detached HEAD");
		assertUnchanged(before);
	});

	it.each([
		false,
		true,
	])("preserves a target directory that already exists, empty=%s", async (empty) => {
		const path = ownedWorktreePath(context.configDir, context.folder);
		mkdirSync(path, { recursive: true });
		if (!empty) writeFileSync(join(path, "keep.txt"), "keep\n");
		const before = repositoryState();
		expect((await creationError()).reason).toBe("target-exists");
		expect(repositoryState()).toEqual(before);
		expect(existsSync(path)).toBe(true);
		if (!empty)
			expect(readFileSync(join(path, "keep.txt"), "utf8")).toBe("keep\n");
	});

	it("reports missing git without creating anything", async () => {
		const before = repositoryState();
		const error = await creationError(undefined, {
			gitExecutable: join(context.fixture, "missing-git"),
		});
		expect(error.reason).toBe("git-failed");
		expect(error.message).toContain("Git executable was not found");
		assertUnchanged(before);
	});

	it("reports a failing git command specifically without creating anything", async () => {
		const before = repositoryState();
		const executable = gitWrapper(
			'console.error("forced git failure"); process.exit(42);',
		);
		const error = await creationError(undefined, { gitExecutable: executable });
		expect(error.reason).toBe("git-failed");
		expect(error.message).toContain("forced git failure");
		assertUnchanged(before);
	});

	it("suffixes a generated branch without changing the colliding ref", async () => {
		const name = "conduit/session-trace-sessio";
		git("branch", name);
		const head = git("rev-parse", name);
		const created = await Effect.runPromise(createEffect());
		expect(created.branchName).toBe(`${name}-2`);
		expect(git("rev-parse", name)).toBe(head);
	});

	it.each([
		{ branches: ["conduit"], expected: "conduit-session-trace-sessio" },
		{
			branches: ["conduit/session-trace-sessio/child"],
			expected: "conduit/session-trace-sessio-2",
		},
		{
			branches: [
				"conduit/session-trace-sessio",
				"conduit/session-trace-sessio-2/child",
			],
			expected: "conduit/session-trace-sessio-3",
		},
		{
			branches: ["conduit", "conduit-session-trace-sessio/child"],
			expected: "conduit-session-trace-sessio-2",
		},
	])("avoids existing ref namespaces $branches", async ({
		branches,
		expected,
	}) => {
		for (const branch of branches) git("branch", branch);
		const before = repositoryState();
		const created = await Effect.runPromise(createEffect());
		expect(created.branchName).toBe(expected);
		for (const branch of branches)
			expect(git("rev-parse", branch)).toBe(git("rev-parse", "HEAD"));
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.rollback(created),
			).pipe(Effect.provide(makeWorktreeLive(context.configDir))),
		);
		assertUnchanged(before);
	});

	it("preserves a concurrent creator's successful checkout", async () => {
		const results = await Promise.all([
			Effect.runPromise(Effect.result(createEffect())),
			Effect.runPromise(Effect.result(createEffect())),
		]);
		const successes = results.filter(Either.isSuccess);
		const failures = results.filter(Either.isFailure);
		expect(successes).toHaveLength(1);
		expect(failures).toHaveLength(1);
		const created = successes[0]?.success;
		expect(created).toBeDefined();
		expect(existsSync(created?.worktrees[context.repository] ?? "")).toBe(true);
		expect(
			git(
				"for-each-ref",
				"--format=%(refname:lstrip=2)",
				"refs/heads/conduit/",
			),
		).toBe(created?.branchName);
	});

	it("ignores inherited git directory, index and configuration overrides", async () => {
		vi.stubEnv("GIT_DIR", join(context.fixture, "wrong-git"));
		vi.stubEnv("GIT_WORK_TREE", context.fixture);
		vi.stubEnv("GIT_INDEX_FILE", join(context.fixture, "wrong-index"));
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
		const created = await Effect.runPromise(createEffect());
		expect(
			readFileSync(
				join(created.worktrees[context.repository] ?? "", "tracked.txt"),
				"utf8",
			),
		).toBe("committed\n");
		expect(existsSync(join(context.fixture, "wrong-index"))).toBe(false);
	});

	it("maps a repository subdirectory into the new checkout", async () => {
		context.folder = {
			...context.folder,
			path: join(context.repository, "app"),
		};
		const created = await Effect.runPromise(createEffect());
		const root = ownedWorktreePath(context.configDir, context.folder);
		expect(created.worktrees[context.folder.path]).toBe(join(root, "app"));
		expect(created.ownership[0]?.path).toBe(root);
		expect(
			readFileSync(
				join(created.worktrees[context.folder.path] ?? "", "app.txt"),
				"utf8",
			),
		).toBe("app committed\n");
	});
});
