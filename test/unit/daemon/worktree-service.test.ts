/*
 * Failure modes, written before the implementation:
 * - An explicit branch already exists: refuse it and preserve its ref and checkout.
 * - A branch name is invalid: refuse it without creating a ref or directory.
 * - The base checkout is dirty: create from committed HEAD and leave its edits there.
 * - The base has detached HEAD: report it without creating anything.
 * - An explicit base is a local branch; tags, remotes and revision expressions
 *   fail during preflight, before any folder gets a checkout or generated branch.
 * - An explicit base works from detached HEAD; a non-git folder cannot have a base.
 * - The target path already exists, even when empty: preserve it and all existing refs.
 * - Git is missing or fails: show the operation's error and leave nothing behind.
 * - Git writes the branch ref then reports failure or times out: use its reflog
 *   ownership marker to remove this attempt's ref and preserve competing refs.
 * - Git adds the worktree then reports failure or times out: remove its registration,
 *   directory and the branch created by this attempt.
 * - Creation is interrupted or later session initialization fails: roll back ownership.
 * - Generated branch names collide, including ref ancestor/descendant namespaces:
 *   choose a valid unused name without changing existing refs.
 * - Concurrent creators race for the same target: preserve the successful owner's tree.
 * - Git environment variables point elsewhere: operate only on the requested repository.
 * - A path beneath the owned root is an outward symlink: reject its original spelling.
 * - A project folder is a repository subdirectory: map it to that same relative folder.
 * - The second repository fails after creation: remove every owned checkout and branch.
 * - A branch exists only in a later repository: preserve it and change neither repository.
 * - Generated branch namespaces conflict in another repository: choose one name free in all.
 * - Non-git folders are skipped; zero git folders cannot create a worktree session.
 * - Folders sharing a repository must map into one owned checkout on the new branch.
 * - A missing checkout is recreated from its existing, possibly renamed branch,
 *   preserving branch commits and the source checkout's edits.
 * - The recovery branch is deleted or its worktree registration was pruned:
 *   refuse recovery without guessing a branch or creating a replacement ref.
 * - A recovery target is occupied by a directory, file or symlink: preserve it.
 * - The recovery branch is checked out in another live worktree: refuse instead
 *   of forcing two live checkouts onto the same branch.
 * - Git fails before or after adding the recovered checkout: preserve the branch
 *   and main checkout, and leave no partially populated directory.
 * - Two recreations race for one target: only one owns it, the loser preserves it.
 * - A recorded path points outside the owned location: refuse recovery.
 * - The main checkout's project subfolder disappears while its isolated copy
 *   remains: keep that checkout usable and recover through the main Git root.
 * - Multi-folder list inspection calls Git for present checkouts, or skips a
 *   missing extra checkout. Inspect only the absent or unusable folders.
 * - The first missing folder can recover but a later branch is deleted:
 *   aggregate availability must refuse partial recreation.
 * - Branch rename preflight checks every repository before writing any ref.
 * - Same-name renames are no-ops; shared checkouts are renamed once.
 * - A failed or interrupted rename restores earlier refs, including a Git
 *   command that updated the ref before reporting failure.
 * - Setup exits non-zero: stream its output and report the original exit code.
 * - Setup hangs beyond its deadline: kill its process group and report timeout.
 * - Setup prints excessive or split UTF-8 output: preserve text within 64 KiB,
 *   emit one truncation note, and keep draining until the script finishes.
 * - A background child holds the pipes after setup exits: kill it, preserve the
 *   shell's outcome, and finish without waiting for the child's natural exit.
 * - Stream interruption closes ownership: kill both the shell and descendants.
 * - The daemon dies without finalizers: pipe EOF stops the detached setup
 *   process group; the user's script still receives /dev/null as stdin.
 * - Setup uses its effective directory and project environment through the
 *   user's login shell; an unset or missing shell falls back to /bin/sh -c.
 * - Setup cannot spawn in its directory: return a failed update, never a defect.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Chunk, Effect, Either, Exit, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isConduitWorktreePath,
	makeWorktreeLive,
	ownedWorktreePath,
	worktreesRoot,
} from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import {
	type WorktreeFolder,
	WorktreeServiceTag,
} from "../../../src/lib/domain/daemon/Services/worktree-service.js";
import { inspectSessionWorktree } from "../../../src/lib/domain/relay/Services/session-workspace.js";

describe("daemon Worktree service", () => {
	let fixture: string;
	let repository: string;
	let configDir: string;
	let folder: WorktreeFolder;
	const actualGit = execFileSync("which", ["git"], {
		encoding: "utf8",
	}).trim();
	const git = (...args: string[]) =>
		execFileSync(actualGit, args, {
			cwd: repository,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const repositoryState = (directory = repository) => ({
		branches: git(
			"-C",
			directory,
			"for-each-ref",
			"--format=%(refname) %(objectname)",
			"refs/heads",
		),
		worktrees: git("-C", directory, "worktree", "list", "--porcelain"),
	});
	const secondGitFolder = () => {
		const path = join(fixture, "second");
		mkdirSync(path);
		git("-C", path, "init", "-q", "--initial-branch=main");
		git("-C", path, "config", "user.name", "Worktree test");
		git("-C", path, "config", "user.email", "worktree@example.test");
		writeFileSync(join(path, "tracked.txt"), "second committed\n");
		git("-C", path, "add", ".");
		git("-C", path, "commit", "-qm", "Second base");
		return { ...folder, path };
	};
	const createEffect = (
		branchName?: string,
		options?: { gitExecutable?: string; gitTimeoutMs?: number },
		folders: readonly WorktreeFolder[] = [folder],
		baseBranches?: Readonly<Record<string, string>>,
	) =>
		Effect.flatMap(WorktreeServiceTag, (service) =>
			service.create(folders, baseBranches, branchName),
		).pipe(Effect.provide(makeWorktreeLive(configDir, options)));
	const creationError = async (
		branchName?: string,
		options?: { gitExecutable?: string; gitTimeoutMs?: number },
		folders: readonly WorktreeFolder[] = [folder],
		baseBranches?: Readonly<Record<string, string>>,
	) => {
		const result = await Effect.runPromise(
			Effect.either(createEffect(branchName, options, folders, baseBranches)),
		);
		if (Either.isRight(result)) throw new Error("Expected creation to fail");
		return result.left;
	};
	const gitWrapper = (body: string) => {
		const path = join(fixture, "git-wrapper");
		writeFileSync(
			path,
			`#!${process.execPath}\nconst { spawnSync } = require("node:child_process");\nconst { writeFileSync } = require("node:fs");\nconst args = process.argv.slice(2);\n${body}\n`,
		);
		chmodSync(path, 0o755);
		return path;
	};
	const runRealGit = `const result = spawnSync(${JSON.stringify(actualGit)}, args, { stdio: "inherit" });`;
	const waitForGitTimeout = (timeoutMarker: string) =>
		`process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(timeoutMarker)}, "timed out"); process.exit(42); }); setInterval(() => {}, 60_000);`;
	const assertUnchanged = (before: ReturnType<typeof repositoryState>) => {
		expect(repositoryState()).toEqual(before);
		expect(existsSync(ownedWorktreePath(configDir, folder))).toBe(false);
	};

	it.each([
		"invalid",
		"taken",
		"missing",
		"head",
	] as const)("branch rename rejects %s before changing either repository", async (failure) => {
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect("owned", undefined, [folder, second]),
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
			).pipe(Effect.either, Effect.provide(makeWorktreeLive(configDir))),
		);
		if (Either.isRight(result)) throw new Error("Expected rename to fail");
		expect(result.left).toMatchObject({
			folder: failure === "invalid" ? repository : second.path,
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
				folder,
				{ ...folder, path: join(repository, "app") },
			]),
		);
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(created.ownership, "renamed"),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		const ownership = created.ownership.map((owned) => ({
			...owned,
			branchName: "renamed",
		}));
		const before = repositoryState();
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(ownership, "renamed"),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		expect(repositoryState()).toEqual(before);
		expect(git("branch", "--list", "owned")).toBe("");
		expect(git("branch", "--list", "renamed")).toContain("renamed");
	});

	it("rolls back both refs when the second Git rename writes then fails", async () => {
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect("owned", undefined, [folder, second]),
		);
		const secondOwned = created.ownership.find(
			(owned) => owned.folder === second.path,
		);
		if (!secondOwned) throw new Error("Missing second ownership");
		const marker = join(fixture, "rename-failed");
		const executable = gitWrapper(`${runRealGit}
if (args.includes("branch") && args.includes("-m") && args.at(-1) === "renamed" && process.cwd() === ${JSON.stringify(secondOwned.path)} && result.status === 0) {
  writeFileSync(${JSON.stringify(marker)}, "failed after rename");
  process.stderr.write("forced second rename failure");
  process.exit(42);
}
process.exit(result.status ?? 1);`);
		const before = [repositoryState(), repositoryState(second.path)];
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.renameBranch(created.ownership, "renamed"),
			).pipe(
				Effect.either,
				Effect.provide(
					makeWorktreeLive(configDir, { gitExecutable: executable }),
				),
			),
		);
		if (Either.isRight(result)) throw new Error("Expected rename to fail");
		expect(result.left).toMatchObject({
			folder: second.path,
			reason: "git-failed",
		});
		expect(result.left.message).toContain("forced second rename failure");
		expect(existsSync(marker)).toBe(true);
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
	});

	beforeEach(() => {
		fixture = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-worktree-service-")),
		);
		repository = join(fixture, "source");
		configDir = join(fixture, "config");
		mkdirSync(repository);
		mkdirSync(configDir);
		git("init", "-q", "--initial-branch=main");
		git("config", "user.name", "Worktree test");
		git("config", "user.email", "worktree@example.test");
		writeFileSync(join(repository, "tracked.txt"), "committed\n");
		mkdirSync(join(repository, "app"));
		writeFileSync(join(repository, "app", "app.txt"), "app committed\n");
		git("add", ".");
		git("commit", "-qm", "Base");
		folder = {
			path: repository,
			projectSlug: "project",
			sessionId: "trace-session",
		};
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(fixture, { recursive: true, force: true });
	});

	it("rolls back the first repository when the second worktree fails after being added", async () => {
		const second = secondGitFolder();
		const before = [repositoryState(), repositoryState(second.path)];
		const firstAdded = join(fixture, "first-added");
		const executable = gitWrapper(
			`${runRealGit}
if (args.includes("worktree") && args.includes("add") && result.status === 0) {
  if (process.cwd() === ${JSON.stringify(repository)}) writeFileSync(${JSON.stringify(firstAdded)}, "added");
  if (process.cwd() === ${JSON.stringify(second.path)}) { console.error("forced second worktree failure"); process.exit(42); }
}
process.exit(result.status ?? 1);`,
		);
		const error = await creationError(
			"feature/together",
			{ gitExecutable: executable },
			[folder, second],
		);
		expect(error.path).toBe(second.path);
		expect(error.message).toContain("forced second worktree failure");
		expect(existsSync(firstAdded)).toBe(true);
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
		for (const entry of [folder, second])
			expect(existsSync(ownedWorktreePath(configDir, entry))).toBe(false);
	});

	it.each([
		undefined,
		"feature/together",
	])("creates the same branch in both git folders, requested=%s", async (branch) => {
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(branch, undefined, [folder, second]),
		);
		expect(Object.keys(created.worktrees)).toEqual([repository, second.path]);
		expect(created.ownership).toHaveLength(2);
		for (const entry of [folder, second]) {
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
		const app = { ...folder, path: join(repository, "app") };
		const api = { ...folder, path: join(repository, "api") };
		mkdirSync(api.path);
		writeFileSync(join(api.path, "api.txt"), "api committed\n");
		git("add", ".");
		git("commit", "-qm", "Add API");
		const entries = layout === "siblings" ? [app, api] : [folder, app];
		const before = repositoryState();
		const created = await Effect.runPromise(
			createEffect("feature/together", undefined, entries),
		);
		expect(created.ownership).toHaveLength(1);
		const checkout = created.ownership[0]?.path ?? "";
		for (const entry of entries) {
			const path = created.worktrees[entry.path] ?? "";
			expect(path).toBe(
				entry.path === repository
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
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		expect(repositoryState()).toEqual(before);
		expect(existsSync(checkout)).toBe(false);
	});

	it("rejects different base commits for folders sharing a repository", async () => {
		const extra = { ...folder, path: join(fixture, "different-base") };
		git("worktree", "add", "-b", "different", extra.path);
		writeFileSync(join(extra.path, "tracked.txt"), "different base\n");
		git("-C", extra.path, "commit", "-qam", "Different base");
		const before = repositoryState();
		const error = await creationError("feature/together", undefined, [
			folder,
			extra,
		]);
		expect(error.reason).toBe("unsupported-project");
		expect(error.message).toContain("different base commits");
		expect(repositoryState()).toEqual(before);
		for (const entry of [folder, extra])
			expect(existsSync(ownedWorktreePath(configDir, entry))).toBe(false);
	});

	it("skips non-git folders, including a non-git primary", async () => {
		const scratch = { ...folder, path: join(fixture, "scratch") };
		mkdirSync(scratch.path);
		writeFileSync(join(scratch.path, "keep.txt"), "shared\n");
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [scratch, folder, second]),
		);
		expect(Object.keys(created.worktrees)).toEqual([repository, second.path]);
		expect(created.ownership).toHaveLength(2);
		expect(existsSync(ownedWorktreePath(configDir, scratch))).toBe(false);
		expect(readFileSync(join(scratch.path, "keep.txt"), "utf8")).toBe(
			"shared\n",
		);
	});

	it("preserves an explicit branch that exists only in the second repository", async () => {
		const second = secondGitFolder();
		git("-C", second.path, "branch", "feature/taken");
		const before = [repositoryState(), repositoryState(second.path)];
		const error = await creationError("feature/taken", undefined, [
			folder,
			second,
		]);
		expect(error.reason).toBe("branch-exists");
		expect(error.path).toBe(second.path);
		expect([repositoryState(), repositoryState(second.path)]).toEqual(before);
		for (const entry of [folder, second])
			expect(existsSync(ownedWorktreePath(configDir, entry))).toBe(false);
	});

	it("chooses a generated branch free in every repository namespace", async () => {
		const second = secondGitFolder();
		git("-C", second.path, "branch", "conduit");
		git("branch", "conduit-session-trace-sessio");
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [folder, second]),
		);
		expect(created.branchName).toBe("conduit-session-trace-sessio-2");
		for (const entry of [folder, second])
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
		const path = created.worktrees[repository];
		expect(path).toBe(ownedWorktreePath(configDir, folder));
		expect(
			path?.startsWith(`${worktreesRoot(configDir)}/project/trace-session/`),
		).toBe(true);
		expect(created.branchName).toMatch(/^conduit\/session-trace-sessio/);
		expect(git("rev-parse", created.branchName)).toBe(git("rev-parse", "HEAD"));
		expect(readFileSync(join(path ?? "", "tracked.txt"), "utf8")).toBe(
			"committed\n",
		);
		await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.rollback(created),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		assertUnchanged(before);
	});

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
			service.inspectRemoval(folder, owned),
		).pipe(Effect.provide(makeWorktreeLive(configDir)));
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
				service.inspectRemoval(folder, owned),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
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
				service.remove(folder, owned),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		expect(existsSync(owned.path)).toBe(false);
		expect(git("for-each-ref", "--format=%(refname)", "refs/heads/owned")).toBe(
			"",
		);
		expect(git("rev-parse", local)).toBe(tip);
		expect(git("rev-parse", "origin/main")).toBe(owned.head);
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
				service.remove(folder, owned),
			).pipe(Effect.either, Effect.provide(makeWorktreeLive(configDir))),
		);
		expect(Either.isLeft(result)).toBe(detached);
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
				service.remove(folder, owned, Effect.succeed(protection === "in-use")),
			).pipe(Effect.either, Effect.provide(makeWorktreeLive(configDir))),
		);
		if (Either.isRight(result)) throw new Error("Expected removal to fail");
		expect(result.left.message).toContain(
			protection === "dirty" ? "uncommitted changes" : "another session",
		);
		expect(existsSync(owned.path)).toBe(true);
		expect(git("rev-parse", "owned")).toBe(git("rev-parse", "main"));
	});

	it.each([
		"main",
		"master",
		"trunk",
	])("preserves a session branch renamed to default branch %s during removal", async (branch) => {
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
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(folder, { ...owned, branchName: branch }),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		expect(existsSync(owned.path)).toBe(false);
		expect(git("rev-parse", branch)).toBe(tip);
	});

	it("preserves the session branch if local main resets after the merge proof", async () => {
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
		const resettingGit = gitWrapper(`
if (args.includes("update-ref") && args.includes("--stdin")) {
  spawnSync(${JSON.stringify(actualGit)}, ["-C", ${JSON.stringify(repository)}, "update-ref", "refs/heads/main", ${JSON.stringify(owned.head)}]);
}
${runRealGit}
process.exit(result.status ?? 1);
`);
		const result = await Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.remove(folder, owned),
			).pipe(
				Effect.either,
				Effect.provide(
					makeWorktreeLive(configDir, { gitExecutable: resettingGit }),
				),
			),
		);
		if (Either.isRight(result))
			throw new Error("Expected deletion transaction to fail");
		expect(result.left.message).toContain("refs/heads/main");
		expect(existsSync(owned.path)).toBe(false);
		expect(git("rev-parse", "owned")).toBe(tip);
		expect(git("rev-parse", "main")).toBe(owned.head);
	});

	it("uses the explicit local base only for its folder", async () => {
		const baseHead = git("rev-parse", "HEAD");
		git("branch", "feature/base");
		writeFileSync(join(repository, "tracked.txt"), "current branch commit\n");
		git("commit", "-qam", "Current branch advances");
		const second = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [folder, second], {
				[repository]: "feature/base",
			}),
		);
		expect(
			git("-C", created.worktrees[repository] ?? "", "rev-parse", "HEAD"),
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
		const error = await creationError(undefined, undefined, [second, folder], {
			[repository]: base,
		});
		expect(error.reason).toBe("invalid-branch");
		expect(error.message).toContain(base);
		assertUnchanged(before);
		expect(repositoryState(second.path)).toEqual(beforeSecond);
		expect(existsSync(ownedWorktreePath(configDir, second))).toBe(false);
	});

	it("uses an explicit local base even when the source HEAD is detached", async () => {
		git("checkout", "-q", "--detach");
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [folder], { [repository]: "main" }),
		);
		expect(
			git("-C", created.worktrees[repository] ?? "", "rev-parse", "HEAD"),
		).toBe(git("rev-parse", "main"));
	});

	it("rejects an explicit base for a non-git folder", async () => {
		const scratch = { ...folder, path: join(fixture, "scratch") };
		mkdirSync(scratch.path);
		const before = repositoryState();
		const error = await creationError(undefined, undefined, [folder, scratch], {
			[scratch.path]: "main",
		});
		expect(error.reason).toBe("unsupported-project");
		assertUnchanged(before);
	});

	it("preserves an existing explicit branch and its existing checkout", async () => {
		const existing = join(fixture, "existing");
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
		writeFileSync(join(repository, "tracked.txt"), "staged\n");
		git("add", "tracked.txt");
		writeFileSync(join(repository, "tracked.txt"), "unstaged\n");
		writeFileSync(join(repository, "untracked.txt"), "untracked\n");
		const before = git("status", "--porcelain");
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[repository] ?? "";
		expect(readFileSync(join(path, "tracked.txt"), "utf8")).toBe("committed\n");
		expect(existsSync(join(path, "untracked.txt"))).toBe(false);
		expect(git("-C", path, "status", "--porcelain")).toBe("");
		expect(git("status", "--porcelain")).toBe(before);
		expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe(
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
		const path = ownedWorktreePath(configDir, folder);
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
			gitExecutable: join(fixture, "missing-git"),
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

	it.each([
		"failure",
		"timeout",
	])("rolls back a ref written before git reports %s", async (mode) => {
		const before = repositoryState();
		const marker = join(fixture, "ref-written");
		const timeoutMarker = join(fixture, "ref-timeout-observed");
		const executable = gitWrapper(
			`${runRealGit}\nif (((args.includes("branch") && args.includes("--")) || args.includes("--create-reflog")) && result.status === 0) { writeFileSync(${JSON.stringify(marker)}, "written"); ${mode === "timeout" ? waitForGitTimeout(timeoutMarker) : 'console.error("forced post-ref failure"); process.exit(42);'} } else process.exit(result.status ?? 1);`,
		);
		const error = await creationError(undefined, {
			gitExecutable: executable,
			gitTimeoutMs: 5_000,
		});
		expect(error.reason).toBe("git-failed");
		expect(existsSync(marker)).toBe(true);
		if (mode === "failure")
			expect(error.message).toContain("forced post-ref failure");
		else expect(existsSync(timeoutMarker)).toBe(true);
		assertUnchanged(before);
	}, 30_000);

	it("rolls back a worktree add that succeeded before reporting failure", async () => {
		const before = repositoryState();
		const executable = gitWrapper(
			`${runRealGit}\nif (args.includes("worktree") && args.includes("add") && result.status === 0) { console.error("forced post-add failure"); process.exit(42); }\nprocess.exit(result.status ?? 1);`,
		);
		const error = await creationError(undefined, { gitExecutable: executable });
		expect(error.reason).toBe("git-failed");
		expect(error.message).toContain("forced post-add failure");
		assertUnchanged(before);
	});

	it("rolls back when a git worktree add times out after creating the checkout", async () => {
		const before = repositoryState();
		const marker = join(fixture, "added-before-timeout");
		const timeoutMarker = join(fixture, "add-timeout-observed");
		const executable = gitWrapper(
			`${runRealGit}\nif (args.includes("worktree") && args.includes("add") && result.status === 0) { writeFileSync(${JSON.stringify(marker)}, "added"); ${waitForGitTimeout(timeoutMarker)} } else process.exit(result.status ?? 1);`,
		);
		const error = await creationError(undefined, {
			gitExecutable: executable,
			gitTimeoutMs: 5_000,
		});
		expect(error.reason).toBe("git-failed");
		expect(existsSync(timeoutMarker)).toBe(true);
		expect(existsSync(marker)).toBe(true);
		assertUnchanged(before);
	}, 30_000);

	it.each([
		false,
		true,
	])("rolls back creation interrupted while git is finishing, delayed startup=%s", async (delayedStartup) => {
		const before = repositoryState();
		const marker = join(fixture, "added");
		const release = join(fixture, "release-git");
		const executable = gitWrapper(
			`${delayedStartup ? 'if (args.includes("--show-toplevel")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);' : ""}\n${runRealGit}\nif (args.includes("worktree") && args.includes("add") && result.status === 0) {
const { existsSync } = require("node:fs");
const finish = () => { if (existsSync(${JSON.stringify(release)})) { clearInterval(gate); process.exit(0); } };
const gate = setInterval(finish, 25);
writeFileSync(${JSON.stringify(marker)}, "added");
finish();
} else process.exit(result.status ?? 1);`,
		);
		const fiber = Effect.runFork(
			createEffect(undefined, { gitExecutable: executable }),
		);
		try {
			await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
				timeout: 8_000,
			});
			expect((await Effect.runPromise(Fiber.poll(fiber)))._tag).toBe("None");
		} finally {
			// Request interruption before allowing Git to return and transfer ownership.
			await Effect.runPromise(Fiber.interruptFork(fiber));
			writeFileSync(release, "release");
			const exit = await Effect.runPromise(Fiber.await(fiber));
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit))
				expect(Cause.isInterrupted(exit.cause)).toBe(true);
		}
		assertUnchanged(before);
	}, 30_000);

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
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		assertUnchanged(before);
	});

	it("preserves a concurrent creator's successful checkout", async () => {
		const results = await Promise.all([
			Effect.runPromise(Effect.either(createEffect())),
			Effect.runPromise(Effect.either(createEffect())),
		]);
		const successes = results.filter(Either.isRight);
		const failures = results.filter(Either.isLeft);
		expect(successes).toHaveLength(1);
		expect(failures).toHaveLength(1);
		const created = successes[0]?.right;
		expect(created).toBeDefined();
		expect(existsSync(created?.worktrees[repository] ?? "")).toBe(true);
		expect(
			git(
				"for-each-ref",
				"--format=%(refname:lstrip=2)",
				"refs/heads/conduit/",
			),
		).toBe(created?.branchName);
	});

	it("ignores inherited git directory, index and configuration overrides", async () => {
		vi.stubEnv("GIT_DIR", join(fixture, "wrong-git"));
		vi.stubEnv("GIT_WORK_TREE", fixture);
		vi.stubEnv("GIT_INDEX_FILE", join(fixture, "wrong-index"));
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
		const created = await Effect.runPromise(createEffect());
		expect(
			readFileSync(
				join(created.worktrees[repository] ?? "", "tracked.txt"),
				"utf8",
			),
		).toBe("committed\n");
		expect(existsSync(join(fixture, "wrong-index"))).toBe(false);
	});

	it("maps a repository subdirectory into the new checkout", async () => {
		folder = { ...folder, path: join(repository, "app") };
		const created = await Effect.runPromise(createEffect());
		const root = ownedWorktreePath(configDir, folder);
		expect(created.worktrees[folder.path]).toBe(join(root, "app"));
		expect(created.ownership[0]?.path).toBe(root);
		expect(
			readFileSync(
				join(created.worktrees[folder.path] ?? "", "app.txt"),
				"utf8",
			),
		).toBe("app committed\n");
	});

	const recreateEffect = (
		directory?: string,
		options?: { gitExecutable?: string; gitTimeoutMs?: number },
	) =>
		Effect.flatMap(WorktreeServiceTag, (service) =>
			service.recreate(folder, directory),
		).pipe(Effect.provide(makeWorktreeLive(configDir, options)));
	const recoveryError = async (
		directory?: string,
		options?: { gitExecutable?: string; gitTimeoutMs?: number },
	) => {
		const result = await Effect.runPromise(
			Effect.either(recreateEffect(directory, options)),
		);
		if (Either.isRight(result)) throw new Error("Expected recreation to fail");
		return result.left;
	};
	const inspectMissing = (directory?: string) =>
		Effect.runPromise(
			Effect.flatMap(WorktreeServiceTag, (service) =>
				service.inspectMissing(folder, directory),
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);

	it("inspects every mapped folder while skipping Git for each present checkout", async () => {
		const extra = secondGitFolder();
		await Effect.runPromise(
			Effect.gen(function* () {
				const service = yield* WorktreeServiceTag;
				const created = yield* service.create([folder, extra]);
				const inspect = () =>
					inspectSessionWorktree(
						{
							id: folder.sessionId,
							workspace: {
								origin: "conduit",
								cause: "launch",
								worktrees: created.worktrees,
							},
						},
						{ projectDir: folder.path, slug: folder.projectSlug },
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
					[folder.path, extra.path],
					undefined,
				);
			}).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
	});

	it("reports both missing folders and a deleted extra branch blocks the whole recovery", async () => {
		const extra = secondGitFolder();
		const created = await Effect.runPromise(
			createEffect(undefined, undefined, [folder, extra]),
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
					id: folder.sessionId,
					workspace: {
						origin: "conduit",
						cause: "launch",
						worktrees: created.worktrees,
					},
				},
				{ projectDir: folder.path, slug: folder.projectSlug },
			).pipe(Effect.provide(makeWorktreeLive(configDir))),
		);
		expect(state?.folders?.map(({ folder }) => folder)).toEqual([
			folder.path,
			extra.path,
		]);
		expect(state).toMatchObject({
			canRecreate: false,
			reason: "branch-missing",
		});
	});

	it("recreates a missing checkout from the registered renamed branch without changing its ref", async () => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[repository] ?? "";
		git("-C", path, "branch", "-m", "renamed-session");
		writeFileSync(join(path, "tracked.txt"), "branch commit\n");
		git("-C", path, "commit", "-qam", "Session commit");
		const head = git("rev-parse", "renamed-session");
		writeFileSync(join(repository, "tracked.txt"), "main edit\n");
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
		const path = created.worktrees[repository] ?? "";
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
		rmSync(created.worktrees[repository] ?? "", { recursive: true });
		git("worktree", "prune");
		const before = repositoryState();
		expect((await inspectMissing())?.reason).toBe("branch-unknown");
		expect((await recoveryError()).reason).toBe("branch-unknown");
		assertUnchanged(before);
	});

	it("refuses a recovery branch checked out in another live worktree", async () => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[repository] ?? "";
		rmSync(path, { recursive: true });
		const other = join(fixture, "other-checkout");
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
		const path = created.worktrees[repository] ?? "";
		rmSync(path, { recursive: true });
		if (kind === "directory") {
			mkdirSync(path);
			writeFileSync(join(path, "keep.txt"), "keep\n");
		} else if (kind === "file") writeFileSync(path, "keep\n");
		else symlinkSync(repository, path);
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
		expect(readFileSync(join(repository, "tracked.txt"), "utf8")).toBe(
			"committed\n",
		);
	});

	it.each([
		false,
		true,
	])("preserves the branch when Git recreation fails, after add=%s", async (afterAdd) => {
		const created = await Effect.runPromise(createEffect());
		const path = created.worktrees[repository] ?? "";
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
		const path = created.worktrees[repository] ?? "";
		rmSync(path, { recursive: true });
		const results = await Promise.all([
			Effect.runPromise(Effect.either(recreateEffect())),
			Effect.runPromise(Effect.either(recreateEffect())),
		]);
		expect(results.filter(Either.isRight)).toHaveLength(1);
		expect(
			results.filter(Either.isLeft).map(({ left }) => left.reason),
		).toEqual(["target-exists"]);
		expect(git("-C", path, "branch", "--show-current")).toBe(
			created.branchName,
		);
	});

	it("recreates a repository subdirectory at its original mapping", async () => {
		folder = { ...folder, path: join(repository, "app") };
		const created = await Effect.runPromise(createEffect());
		const directory = created.worktrees[folder.path] ?? "";
		rmSync(ownedWorktreePath(configDir, folder), { recursive: true });
		expect(await Effect.runPromise(recreateEffect(directory))).toBe(directory);
		expect(readFileSync(join(directory, "app.txt"), "utf8")).toBe(
			"app committed\n",
		);
	});

	it("keeps and recreates the isolated subfolder when its main copy is missing", async () => {
		folder = { ...folder, path: join(repository, "app") };
		const created = await Effect.runPromise(createEffect());
		const directory = created.worktrees[folder.path] ?? "";
		rmSync(folder.path, { recursive: true });
		expect(await inspectMissing(directory)).toBeUndefined();
		const main = git("status", "--porcelain");
		rmSync(ownedWorktreePath(configDir, folder), { recursive: true });
		expect((await inspectMissing(directory))?.canRecreate).toBe(true);
		expect(await Effect.runPromise(recreateEffect(directory))).toBe(directory);
		expect(readFileSync(join(directory, "app.txt"), "utf8")).toBe(
			"app committed\n",
		);
		expect(git("status", "--porcelain")).toBe(main);
		expect(existsSync(folder.path)).toBe(false);
	});

	it("refuses a path outside the owned location", async () => {
		const before = repositoryState();
		expect((await recoveryError(join(fixture, "unowned"))).reason).toBe(
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
		const scratch = { ...folder, path: join(fixture, "scratch") };
		mkdirSync(scratch.path);
		expect((await creationError(undefined, undefined, [scratch])).reason).toBe(
			"unsupported-project",
		);
		expect(existsSync(worktreesRoot(configDir))).toBe(false);
	});

	it("guards the root and descendants, including symlink aliases and absent children", () => {
		const root = worktreesRoot(configDir);
		mkdirSync(root);
		const alias = join(fixture, "worktree-alias");
		symlinkSync(root, alias);
		expect(isConduitWorktreePath(configDir, root)).toBe(true);
		expect(
			isConduitWorktreePath(configDir, join(root, "not-created", "child")),
		).toBe(true);
		expect(isConduitWorktreePath(configDir, alias)).toBe(true);
		expect(
			isConduitWorktreePath(configDir, join(alias, "not-created", "child")),
		).toBe(true);
		expect(isConduitWorktreePath(configDir, `${root}-elsewhere`)).toBe(false);
		expect(isConduitWorktreePath(configDir, repository)).toBe(false);
	});

	it("refuses outward symlinks beneath both root spellings", () => {
		const root = worktreesRoot(configDir);
		mkdirSync(root);
		const outward = join(root, "outward");
		symlinkSync(repository, outward);
		expect(isConduitWorktreePath(configDir, outward)).toBe(true);
		expect(isConduitWorktreePath(configDir, join(outward, "app"))).toBe(true);
		const alias = join(fixture, "config-alias");
		symlinkSync(configDir, alias);
		expect(
			isConduitWorktreePath(alias, join(alias, "worktrees", "outward")),
		).toBe(true);
		expect(isConduitWorktreePath(alias, outward)).toBe(true);
	});
});

describe("daemon Worktree setup runner", () => {
	let fixture: string;
	let directory: string;
	const setupEffect = (
		script: string,
		env: Readonly<Record<string, string | undefined>> = {
			...process.env,
			SHELL: "/bin/sh",
		},
		setupTimeoutMs = 2_000,
		cwd = directory,
	) =>
		Effect.flatMap(WorktreeServiceTag, (service) =>
			Stream.runCollect(service.runSetup(cwd, script, env)),
		).pipe(
			Effect.provide(makeWorktreeLive(fixture, { setupTimeoutMs })),
			Effect.map(Chunk.toReadonlyArray),
		);
	const outputText = (
		updates: readonly { readonly _tag: string; readonly output?: string }[],
	) =>
		updates
			.filter((update) => update._tag === "output")
			.map((update) => update.output ?? "")
			.join("");
	const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const pidIsAlive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const expectStopped = async (pidFile: string) => {
		const pid = Number(readFileSync(pidFile, "utf8"));
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		await expect.poll(() => pidIsAlive(pid), { timeout: 10_000 }).toBe(false);
	};

	beforeEach(() => {
		fixture = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-worktree-setup-")),
		);
		directory = join(fixture, "worktree");
		mkdirSync(directory);
	});

	afterEach(() => {
		rmSync(fixture, { recursive: true, force: true });
	});

	it("runs in the effective directory and streams output before finishing", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"printf 'stdout-first\\n'; printf 'stderr-second\\n' >&2; printf '%s' \"$CONDUIT_SETUP_ENV\" > marker",
				{ ...process.env, SHELL: "/bin/sh", CONDUIT_SETUP_ENV: "project" },
			),
		);
		expect(readFileSync(join(directory, "marker"), "utf8")).toBe("project");
		expect(outputText(updates)).toBe("stdout-first\nstderr-second\n");
		expect(updates.at(-1)).toEqual({
			_tag: "finished",
			status: "succeeded",
			exitCode: 0,
		});
	});

	it("reports non-zero exit with stdout and stderr intact", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"printf 'failed output\\n'; printf 'error detail\\n' >&2; exit 23",
			),
		);
		expect(outputText(updates)).toBe("failed output\nerror detail\n");
		expect(updates.at(-1)).toEqual({
			_tag: "finished",
			status: "failed",
			exitCode: 23,
		});
	});

	it("times out a hanging script and kills the entire process group", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"echo $$ > shell.pid; sleep 60 & echo $! > child.pid; wait",
				{ ...process.env, SHELL: "/bin/sh" },
				100,
			),
		);
		expect(updates.at(-1)).toMatchObject({
			_tag: "finished",
			status: "timed_out",
		});
		await expectStopped(join(directory, "shell.pid"));
		await expectStopped(join(directory, "child.pid"));
	});

	it("caps large output once without splitting a UTF-8 character", async () => {
		const body = "process.stdout.write('🙂'.repeat(40_000));";
		const updates = await Effect.runPromise(
			setupEffect(`${shellQuote(process.execPath)} -e ${shellQuote(body)}`),
		);
		const text = outputText(updates);
		expect(text).not.toContain("\uFFFD");
		expect(text.startsWith("🙂".repeat(16_384))).toBe(true);
		expect(text.match(/\[Setup output truncated after 64 KiB\]/g)).toHaveLength(
			1,
		);
		expect(Buffer.byteLength(text)).toBeLessThan(65_700);
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
	});

	it("decodes UTF-8 characters split between streamed chunks", async () => {
		const body =
			"const bytes = Buffer.from('🙂'); process.stdout.write(bytes.subarray(0, 2)); setTimeout(() => process.stdout.write(bytes.subarray(2)), 30);";
		const updates = await Effect.runPromise(
			setupEffect(`${shellQuote(process.execPath)} -e ${shellQuote(body)}`),
		);
		expect(outputText(updates)).toBe("🙂");
	});

	it("kills a background descendant holding output pipes after the shell exits", async () => {
		const updates = await Effect.runPromise(
			setupEffect("sleep 60 & echo $! > child.pid; printf 'shell done\\n'"),
		);
		expect(outputText(updates)).toBe("shell done\n");
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
		await expectStopped(join(directory, "child.pid"));
	});

	it("interrupts the setup shell and its descendants when the stream closes", async () => {
		const fiber = Effect.runFork(
			setupEffect("echo $$ > shell.pid; sleep 60 & echo $! > child.pid; wait"),
		);
		try {
			await expect
				.poll(() => existsSync(join(directory, "child.pid")))
				.toBe(true);
		} finally {
			await Effect.runPromise(Fiber.interrupt(fiber));
		}
		await expectStopped(join(directory, "shell.pid"));
		await expectStopped(join(directory, "child.pid"));
	});

	it("gives the user's setup script closed stdin", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"if IFS= read -r value; then printf 'unexpected input'; else printf 'stdin closed'; fi",
			),
		);
		expect(outputText(updates)).toBe("stdin closed");
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
	});

	it("stops the setup process group when its fixture daemon is killed abruptly", async () => {
		const serviceUrl = new URL(
			"../../../src/lib/domain/daemon/Services/worktree-service.ts",
			import.meta.url,
		).href;
		const layerUrl = new URL(
			"../../../src/lib/domain/daemon/Layers/worktree-layer.ts",
			import.meta.url,
		).href;
		const script = "echo $$ > shell.pid; sleep 60 & echo $! > child.pid; wait";
		const parent = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`import { Effect, Stream } from "effect";
import { WorktreeServiceTag } from ${JSON.stringify(serviceUrl)};
import { makeWorktreeLive } from ${JSON.stringify(layerUrl)};
Effect.runFork(Effect.flatMap(WorktreeServiceTag, (service) =>
  Stream.runDrain(service.runSetup(${JSON.stringify(directory)}, ${JSON.stringify(script)}, { ...process.env, SHELL: "/bin/sh" }))
).pipe(Effect.provide(makeWorktreeLive(${JSON.stringify(fixture)}, { setupTimeoutMs: 60_000 }))));`,
			],
			{ cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
		);
		let parentStderr = "";
		parent.stderr.on("data", (chunk: Buffer) => {
			parentStderr = (parentStderr + chunk.toString()).slice(-2_000);
		});
		const parentExited = new Promise<void>((accept, reject) => {
			parent.once("close", () => accept());
			parent.once("error", reject);
		});
		const childPidFile = join(directory, "child.pid");
		let groupPid: number | undefined;
		try {
			await expect
				.poll(
					() => {
						if (parent.exitCode !== null || parent.signalCode !== null)
							throw new Error(
								`Fixture daemon exited before setup: ${parentStderr}`,
							);
						// The shell creates child.pid before writing it. Killing the daemon
						// inside that gap leaves an empty file, so wait for the whole pid.
						return (
							existsSync(childPidFile) &&
							/^\d+\n$/.test(readFileSync(childPidFile, "utf8"))
						);
					},
					// A cold tsx start takes seconds when the machine is busy.
					{ timeout: 30_000 },
				)
				.toBe(true);
			groupPid = Number(readFileSync(join(directory, "shell.pid"), "utf8"));
			expect(Number.isSafeInteger(groupPid) && groupPid > 0).toBe(true);
			expect(parent.kill("SIGKILL")).toBe(true);
			await parentExited;
			await expectStopped(join(directory, "shell.pid"));
			await expectStopped(childPidFile);
		} finally {
			parent.kill("SIGKILL");
			await parentExited;
			// This PID came from the process group started by this fixture, never
			// from persisted daemon state. Clean it up even if the assertion fails.
			if (groupPid) {
				try {
					process.kill(-groupPid, "SIGKILL");
				} catch {
					// Successful watchdog cleanup already removed this owned group.
				}
			}
		}
	}, 60_000);

	it("uses the configured user's shell with login and command flags", async () => {
		const shell = join(fixture, "user-shell");
		writeFileSync(
			shell,
			'#!/bin/sh\nprintf \'%s\' "$1" > shell-flags\nexec /bin/sh -c "$2"\n',
		);
		chmodSync(shell, 0o755);
		await Effect.runPromise(
			setupEffect("printf 'custom shell' > marker", {
				...process.env,
				SHELL: shell,
			}),
		);
		expect(readFileSync(join(directory, "shell-flags"), "utf8")).toBe("-lc");
		expect(readFileSync(join(directory, "marker"), "utf8")).toBe(
			"custom shell",
		);
	});

	it.each([
		undefined,
		"/conduit-test-missing-shell",
	])("falls back to /bin/sh when SHELL is %s", async (shell) => {
		const updates = await Effect.runPromise(
			setupEffect("printf 'fallback' > marker", {
				...process.env,
				SHELL: shell,
			}),
		);
		expect(readFileSync(join(directory, "marker"), "utf8")).toBe("fallback");
		expect(updates.at(-1)).toMatchObject({ status: "succeeded", exitCode: 0 });
	});

	it("returns a failed terminal update when its working directory is missing", async () => {
		const updates = await Effect.runPromise(
			setupEffect(
				"printf 'unreachable'",
				{ ...process.env, SHELL: "/bin/sh" },
				2_000,
				join(fixture, "missing"),
			),
		);
		expect(updates).toEqual([
			{
				_tag: "finished",
				status: "failed",
				message: expect.stringContaining("Could not start setup script"),
			},
		]);
	});
});
