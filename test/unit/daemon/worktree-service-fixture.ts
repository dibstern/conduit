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
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result as Either } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import {
	makeWorktreeLive,
	ownedWorktreePath,
} from "../../../src/lib/domain/daemon/Layers/worktree-layer.js";
import {
	type WorktreeFolder,
	WorktreeServiceTag,
} from "../../../src/lib/domain/daemon/Services/worktree-service.js";

export const worktreeFixture = () => {
	const context = {
		fixture: "",
		repository: "",
		configDir: "",
		folder: { path: "", projectSlug: "project", sessionId: "trace-session" },
	};
	let seed: string;
	const actualGit = execFileSync("which", ["git"], {
		encoding: "utf8",
	}).trim();
	const git = (...args: string[]) =>
		execFileSync(actualGit, args, {
			cwd: context.repository,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const repositoryState = (directory = context.repository) => ({
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
		const path = join(context.fixture, "second");
		mkdirSync(path);
		git("-C", path, "init", "-q", "--initial-branch=main");
		git("-C", path, "config", "user.name", "Worktree test");
		git("-C", path, "config", "user.email", "worktree@example.test");
		writeFileSync(join(path, "tracked.txt"), "second committed\n");
		git("-C", path, "add", ".");
		git("-C", path, "commit", "-qm", "Second base");
		return { ...context.folder, path };
	};
	const createEffect = (
		branchName?: string,
		options?: Parameters<typeof makeWorktreeLive>[1],
		folders: readonly WorktreeFolder[] = [context.folder],
		baseBranches?: Readonly<Record<string, string>>,
	) =>
		Effect.flatMap(WorktreeServiceTag, (service) =>
			service.create(folders, baseBranches, branchName),
		).pipe(Effect.provide(makeWorktreeLive(context.configDir, options)));
	const creationError = async (
		branchName?: string,
		options?: Parameters<typeof makeWorktreeLive>[1],
		folders: readonly WorktreeFolder[] = [context.folder],
		baseBranches?: Readonly<Record<string, string>>,
	) => {
		const result = await Effect.runPromise(
			Effect.result(createEffect(branchName, options, folders, baseBranches)),
		);
		if (Either.isSuccess(result)) throw new Error("Expected creation to fail");
		return result.failure;
	};
	const gitWrapper = (body: string) => {
		const path = join(context.fixture, "git-wrapper");
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
		expect(
			existsSync(ownedWorktreePath(context.configDir, context.folder)),
		).toBe(false);
	};

	beforeAll(() => {
		seed = realpathSync(mkdtempSync(join(tmpdir(), "conduit-worktree-seed-")));
		context.repository = seed;
		git("init", "-q", "--initial-branch=main");
		git("config", "user.name", "Worktree test");
		git("config", "user.email", "worktree@example.test");
		writeFileSync(join(seed, "tracked.txt"), "committed\n");
		mkdirSync(join(seed, "app"));
		writeFileSync(join(seed, "app", "app.txt"), "app committed\n");
		git("add", ".");
		// Keep detached auto-maintenance from mutating the reusable seed during copying.
		git("-c", "maintenance.auto=false", "commit", "-qm", "Base");
	});

	beforeEach(() => {
		context.fixture = realpathSync(
			mkdtempSync(join(tmpdir(), "conduit-worktree-service-")),
		);
		context.repository = join(context.fixture, "source");
		context.configDir = join(context.fixture, "config");
		cpSync(seed, context.repository, { recursive: true });
		mkdirSync(context.configDir);
		context.folder = {
			path: context.repository,
			projectSlug: "project",
			sessionId: "trace-session",
		};
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(context.fixture, { recursive: true, force: true });
	});

	afterAll(() => {
		rmSync(seed, { recursive: true, force: true });
	});

	return Object.assign(context, {
		actualGit,
		git,
		repositoryState,
		secondGitFolder,
		createEffect,
		creationError,
		gitWrapper,
		runRealGit,
		waitForGitTimeout,
		assertUnchanged,
	});
};
