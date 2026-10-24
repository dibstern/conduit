import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	invalidateSessionGitRepository,
	readSessionGit,
} from "../../../src/lib/domain/daemon/Layers/session-git/git-reader.js";
import {
	makeSubprocess,
	Subprocess,
} from "../../../src/lib/domain/daemon/Services/subprocess.js";
import { hasNoCommitsBeyondDefault } from "../../../src/lib/git/worktrees.js";

const roots: string[] = [];
const owners: ReturnType<typeof makeSubprocess>[] = [];
const subprocess = () => {
	const owner = makeSubprocess();
	owners.push(owner);
	return { owner, runner: vi.fn(owner.makeRunner()) };
};
const warmRead = async (directory: string) => {
	const { owner, runner } = subprocess();
	const previous = await readSessionGit(directory, undefined, runner);
	expect(runner.mock.calls.some(([, args]) => args.includes("--short"))).toBe(
		false,
	);
	const before = Effect.runSync(owner.metrics);
	runner.mockClear();
	const value = await readSessionGit(directory, previous, runner);
	expect(value).toEqual(previous);
	const after = Effect.runSync(owner.metrics);
	expect(after.spawnCount - before.spawnCount).toBe(1);
	expect(
		(after.commands["git"]?.spawnCount ?? 0) -
			(before.commands["git"]?.spawnCount ?? 0),
	).toBe(1);
	expect(runner.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
		["--no-optional-locks", "status"],
	]);
	expect(runner.mock.calls[0]?.[2].env?.["GIT_OPTIONAL_LOCKS"]).toBe("0");
	return value;
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	}).trim();
const root = () => {
	const directory = mkdtempSync(join(tmpdir(), "conduit-session-git-"));
	roots.push(directory);
	return directory;
};
const repo = () => {
	const directory = root();
	git(directory, "-c", "init.defaultBranch=main", "init", "-q");
	git(directory, "config", "user.name", "Test User");
	git(directory, "config", "user.email", "test@example.com");
	return directory;
};
const commit = (directory: string, name: string) => {
	writeFileSync(join(directory, name), name);
	git(directory, "add", name);
	git(directory, "commit", "-qm", name);
	return git(directory, "rev-parse", "HEAD").slice(0, 7);
};

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const owner of owners.splice(0)) await Effect.runPromise(owner.shutdown);
	for (const directory of roots.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("readSessionGit", () => {
	// Failure modes: HEAD lives in a gitfile/commondir or packed ref; unborn and
	// detached heads differ; a cache misses external ref changes or crosses repos;
	// unusual ref storage needs git.
	it.each([
		"branch",
		"detached",
		"unborn",
		"packed",
		"feature",
	])("uses one subprocess for a warm %s read, preserving the pill", async (kind) => {
		const directory = repo();
		if (kind === "detached") git(directory, "config", "core.abbrev", "12");
		let head: string | undefined;
		if (kind !== "unborn") head = commit(directory, "initial");
		if (kind === "detached") git(directory, "checkout", "--detach", "-q");
		if (kind === "packed") git(directory, "pack-refs", "--all");
		if (kind === "feature") {
			git(directory, "checkout", "-qb", "feature");
			head = commit(directory, "feature-file");
		}
		const value = await warmRead(directory);
		expect(value).toMatchObject({ dirty: false });
		if (head) expect(value?.head).toBe(head);
		else expect(value).not.toHaveProperty("head");
		if (kind === "detached") expect(value).not.toHaveProperty("branch");
		else expect(value?.branch).toBe(kind === "feature" ? "feature" : "main");
		expect(value).not.toHaveProperty("ahead");
		expect(value).not.toHaveProperty("behind");
	});
	it("shares default refs across linked worktrees with relative gitfiles", async () => {
		const directory = repo();
		commit(directory, "initial");
		const linked = join(root(), "linked");
		git(directory, "worktree", "add", "-qb", "feature", linked);
		const gitDir = git(linked, "rev-parse", "--absolute-git-dir");
		writeFileSync(
			join(linked, ".git"),
			`gitdir: ${relative(realpathSync(linked), gitDir)}\n`,
		);
		const { runner } = subprocess();
		await readSessionGit(directory, undefined, runner);
		runner.mockClear();
		await readSessionGit(linked, undefined, runner);
		expect(
			runner.mock.calls.some(([, args]) => args.includes("for-each-ref")),
		).toBe(false);
		expect(await warmRead(linked)).toMatchObject({
			branch: "feature",
			worktree: "linked",
		});
		const nested = join(linked, "nested");
		mkdirSync(nested);
		expect(await warmRead(nested)).toMatchObject({
			branch: "feature",
			worktree: "linked",
		});
	});
	it("reads each folder of a multi-folder workspace with one warm spawn", async () => {
		const folders = [repo(), repo()] as const;
		const heads = folders.map((directory, index) =>
			commit(directory, `file-${index}`),
		);
		const { owner, runner } = subprocess();
		const previous = await Promise.all(
			folders.map((directory) => readSessionGit(directory, undefined, runner)),
		);
		const before = Effect.runSync(owner.metrics).spawnCount;
		const values = await Promise.all(
			folders.map((directory, index) =>
				readSessionGit(directory, previous[index], runner),
			),
		);
		expect(Effect.runSync(owner.metrics).spawnCount - before).toBe(2);
		expect(values.map((value) => value?.head)).toEqual(heads);
	});
	it("invalidates absent, loose, symbolic and packed default refs without a watcher", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "branch", "-m", "topic");
		expect(await warmRead(directory)).not.toHaveProperty("merged");
		git(directory, "branch", "main");
		expect(await warmRead(directory)).toMatchObject({ merged: false });
		git(directory, "branch", "-D", "main");
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		expect(await warmRead(directory)).not.toHaveProperty("merged");
		git(directory, "update-ref", "refs/remotes/origin/trunk", "HEAD");
		expect(await warmRead(directory)).toMatchObject({ merged: false });
		git(directory, "pack-refs", "--all");
		expect(await warmRead(directory)).toMatchObject({ merged: false });
		git(directory, "update-ref", "-d", "refs/remotes/origin/trunk");
		expect(await warmRead(directory)).not.toHaveProperty("merged");
	});
	it("can explicitly invalidate a repository shared by worktrees", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		await warmRead(directory);
		invalidateSessionGitRepository(join(directory, ".git"));
		const { runner } = subprocess();
		await readSessionGit(directory, undefined, runner);
		expect(
			runner.mock.calls.some(([, args]) => args.includes("for-each-ref")),
		).toBe(true);
		expect(
			runner.mock.calls.some(([, args]) => args.includes("merge-base")),
		).toBe(true);
	});
	it("falls back for a symlinked HEAD", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "config", "core.abbrev", "12");
		const head = git(directory, "rev-parse", "--short", "HEAD");
		const headFile = join(directory, ".git", "HEAD");
		rmSync(headFile);
		symlinkSync("refs/heads/main", headFile);
		const { runner } = subprocess();
		expect(await readSessionGit(directory, undefined, runner)).toMatchObject({
			head,
			branch: "main",
		});
		expect(
			runner.mock.calls.some(([, args]) => args.includes("--absolute-git-dir")),
		).toBe(true);
	});
	it("falls back for reftable repositories when supported", async (context) => {
		const directory = root();
		if (
			spawnSync(
				"git",
				["init", "-q", "--ref-format=reftable", "--initial-branch=main"],
				{ cwd: directory },
			).status !== 0
		) {
			context.skip();
			return;
		}
		git(directory, "config", "user.name", "Test User");
		git(directory, "config", "user.email", "test@example.com");
		commit(directory, "initial");
		const head = git(directory, "rev-parse", "--short", "HEAD");
		const { runner } = subprocess();
		expect(await readSessionGit(directory, undefined, runner)).toMatchObject({
			head,
			branch: "main",
			merged: false,
		});
		expect(
			runner.mock.calls.some(([, args]) => args.includes("--absolute-git-dir")),
		).toBe(true);
	});
	it("returns undefined outside a repository", async () => {
		expect(await readSessionGit(root())).toBeUndefined();
	});
	it("skips bare repositories with no working folder", async () => {
		const directory = root();
		git(directory, "init", "--bare", "-q");
		expect(await readSessionGit(directory)).toBeUndefined();
	});
	it("reads a clean named branch and its full and short head", async () => {
		const directory = repo();
		const head = commit(directory, "initial");
		expect(await readSessionGit(directory)).toMatchObject({
			branch: "main",
			head,
			oid: git(directory, "rev-parse", "HEAD"),
			dirty: false,
			merged: false,
		});
		expect(await readSessionGit(directory)).not.toHaveProperty("changes");
	});
	it("counts tracked edits and each untracked file, with line totals against HEAD", async () => {
		const directory = repo();
		// A file named HEAD makes `git diff HEAD` ambiguous without `--`.
		writeFileSync(join(directory, "HEAD"), "one\ntwo\nthree\n");
		git(directory, "add", "HEAD");
		git(directory, "commit", "-qm", "initial");
		writeFileSync(join(directory, "HEAD"), "one\nreplacement\nthree\n");
		git(directory, "add", "HEAD");
		writeFileSync(join(directory, "HEAD"), "one\nreplacement\nthree\nfour\n");
		writeFileSync(
			join(directory, "untracked"),
			"not counted\nin line totals\n",
		);
		mkdirSync(join(directory, "newdir"));
		writeFileSync(join(directory, "newdir", "a"), "a\n");
		writeFileSync(join(directory, "newdir", "b"), "b\n");
		expect(await readSessionGit(directory)).toMatchObject({
			dirty: true,
			changes: { files: 4, insertions: 2, deletions: 1 },
		});
	});
	it("reports modifications to a tracked file as dirty", async () => {
		const directory = repo();
		commit(directory, "tracked");
		writeFileSync(join(directory, "tracked"), "changed");
		expect(await readSessionGit(directory)).toMatchObject({ dirty: true });
	});
	it("reports an untracked file as dirty", async () => {
		const directory = repo();
		commit(directory, "tracked");
		writeFileSync(join(directory, "untracked"), "new");
		expect(await readSessionGit(directory)).toMatchObject({ dirty: true });
	});
	it("reports ahead and behind against an upstream branch", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "upstream");
		commit(directory, "upstream-only");
		git(directory, "checkout", "-qb", "feature", "HEAD~1");
		git(directory, "branch", "--set-upstream-to=upstream", "feature");
		commit(directory, "feature-only");
		expect(await readSessionGit(directory)).toMatchObject({
			branch: "feature",
			upstream: "upstream",
			ahead: 1,
			behind: 1,
			dirty: false,
		});
	});
	it("omits ahead and behind without an upstream", async () => {
		const directory = repo();
		commit(directory, "initial");
		const state = await readSessionGit(directory);
		expect(state).not.toHaveProperty("ahead");
		expect(state).not.toHaveProperty("behind");
		expect(state).not.toHaveProperty("upstream");
	});
	it("omits the branch for detached HEAD", async () => {
		const directory = repo();
		const head = commit(directory, "initial");
		git(directory, "checkout", "--detach", "-q");
		expect(await readSessionGit(directory)).toEqual({
			head,
			oid: git(directory, "rev-parse", "HEAD"),
			dirty: false,
		});
	});
	it("identifies a linked worktree", async () => {
		const directory = repo();
		commit(directory, "initial");
		const linked = join(root(), "linked");
		git(directory, "worktree", "add", "-qb", "feature", linked);
		expect(await readSessionGit(linked)).toMatchObject({
			branch: "feature",
			worktree: "linked",
		});
		expect(await readSessionGit(directory)).not.toHaveProperty("worktree");
	});
	it.each([
		"--no-ff",
		"--ff-only",
	])("dates a %s merge from its commit or default ref reflog", async (strategy) => {
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:01:00Z");
		commit(directory, "feature-file");
		git(directory, "checkout", "-q", "main");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:02:00Z");
		git(directory, "merge", strategy, "-q", "feature");
		const mergedAt = Date.parse("2026-01-01T00:02:00Z");
		expect(Number(git(directory, "log", "-1", "--format=%ct")) * 1_000).toBe(
			strategy === "--no-ff" ? mergedAt : Date.parse("2026-01-01T00:01:00Z"),
		);
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:03:00Z");
		commit(directory, "later-default-work");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({
			branch: "feature",
			merged: true,
			mergedAt,
		});
	});
	it("dates a fast-forward from a reflog entry containing a descendant of the tip", async () => {
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:01:00Z");
		commit(directory, "feature-file");
		git(directory, "checkout", "-qb", "integration");
		commit(directory, "integration-file");
		git(directory, "checkout", "-q", "main");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:02:00Z");
		git(directory, "merge", "--ff-only", "-q", "integration");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedAt: Date.parse("2026-01-01T00:02:00Z"),
		});
	});
	it("uses the earliest merge time across containing default refs", async () => {
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
		const directory = repo();
		commit(directory, "initial");
		git(directory, "branch", "master");
		git(directory, "checkout", "-qb", "feature");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:01:00Z");
		commit(directory, "feature-file");
		git(directory, "checkout", "-q", "master");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:02:00Z");
		git(directory, "merge", "--no-ff", "-qm", "Merge feature", "feature");
		git(directory, "checkout", "-q", "main");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:03:00Z");
		git(directory, "merge", "--no-ff", "-qm", "Merge feature", "feature");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedAt: Date.parse("2026-01-01T00:02:00Z"),
		});
	});
	it("does not mark a fresh branch merged after main advances", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "branch", "feature");
		commit(directory, "main-file");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
	});
	it("does not mark the default branch merged", async () => {
		const directory = repo();
		commit(directory, "initial");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
	});
	it("does not mark an unmerged feature branch merged", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
	});
	it.each([
		["main", "--no-ff"],
		["main", "--ff-only"],
		["master", "--no-ff"],
		["master", "--ff-only"],
	])("recognises a local %s %s merge while origin is stale, until the local branch resets", async (local, strategy) => {
		const directory = repo();
		commit(directory, "initial");
		const initial = git(directory, "rev-parse", "HEAD");
		if (local === "master") git(directory, "branch", "master");
		git(directory, "update-ref", "refs/remotes/origin/main", initial);
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/main",
		);
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		const tip = git(directory, "rev-parse", "HEAD");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
		git(directory, "checkout", "-q", local);
		git(directory, "merge", strategy, "-q", "feature");
		git(directory, "checkout", "-q", "feature");
		expect(git(directory, "rev-parse", "origin/main")).toBe(initial);
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedHead: tip,
		});
		git(directory, "update-ref", `refs/heads/${local}`, initial);
		const reset = await readSessionGit(directory);
		expect(reset).toMatchObject({ merged: false });
		expect(reset).not.toHaveProperty("mergedHead");
	});
	it.each([
		"main",
		"master",
	])("uses local %s when origin HEAD points to a missing ref", async (local) => {
		const directory = repo();
		commit(directory, "initial");
		if (local === "master") git(directory, "branch", "-m", "master");
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/missing",
		);
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		const tip = git(directory, "rev-parse", "HEAD");
		git(directory, "checkout", "-q", local);
		git(directory, "merge", "--ff-only", "-q", "feature");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedHead: tip,
		});
	});
	it.each([
		"main",
		"master",
		"trunk",
	])("never marks default branch %s merged when multiple defaults contain its tip", async (branch) => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "branch", "master");
		git(directory, "branch", "trunk");
		git(directory, "checkout", "-q", branch);
		commit(directory, "default-file");
		git(directory, "update-ref", "refs/remotes/origin/trunk", "HEAD");
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		const state = await readSessionGit(directory);
		expect(state).toMatchObject({ branch, merged: false });
		expect(state).not.toHaveProperty("mergedHead");
	});
	it.each([
		"main",
		"master",
	])("checks the creation-time history of local %s even when origin already contains the tip", async (local) => {
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
		const directory = repo();
		commit(directory, "initial");
		if (local === "master") git(directory, "branch", "master");
		git(directory, "checkout", "-qb", "work");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:01:00Z");
		commit(directory, "feature-file");
		const tip = git(directory, "rev-parse", "HEAD");
		git(directory, "update-ref", "refs/remotes/origin/trunk", tip);
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:02:00Z");
		git(directory, "checkout", "-qb", "feature");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
		git(directory, "checkout", "-q", local);
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:03:00Z");
		git(directory, "merge", "--ff-only", "-q", "feature");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedHead: tip,
		});
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:04:00Z");
		git(directory, "checkout", "-qb", "fresh", local);
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
	});
	it("keeps squash merges undetected", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		git(directory, "checkout", "-q", "main");
		git(directory, "merge", "--squash", "-q", "feature");
		git(directory, "commit", "-qm", "Squash feature");
		git(directory, "checkout", "-q", "feature");
		const state = await readSessionGit(directory);
		expect(state).toMatchObject({ merged: false });
		expect(state).not.toHaveProperty("mergedHead");
	});
	it("detects a merge in origin's default branch when local main is stale", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		git(directory, "update-ref", "refs/remotes/origin/trunk", "HEAD");
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		expect(await readSessionGit(directory)).toMatchObject({
			branch: "feature",
			merged: true,
		});
	});
	it.each([
		["--no-ff", false],
		["--ff-only", false],
		["--no-ff", true],
		["--ff-only", true],
	])("recognises a clone's first fetched %s merge (precommitted branch: %s)", async (strategy, precommitted) => {
		// Cloning does not seed the remote default ref's reflog. A first fetch
		// must still detect the merge, including an unchanged local feature ref.
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
		const seed = repo();
		commit(seed, "initial");
		git(seed, "branch", "-m", "trunk");
		const remote = root();
		git(remote, "init", "--bare", "-q");
		git(seed, "push", "-q", remote, "trunk");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/trunk");
		if (precommitted) {
			git(seed, "checkout", "-qb", "feature");
			commit(seed, "feature-file");
			git(seed, "push", "-q", remote, "feature");
			git(seed, "checkout", "-q", "trunk");
		}
		const directory = root();
		git(directory, "clone", "-q", remote, ".");
		git(directory, "config", "user.name", "Test User");
		git(directory, "config", "user.email", "test@example.com");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:01:00Z");
		git(
			directory,
			"checkout",
			"-qb",
			"feature",
			precommitted ? "origin/feature" : "HEAD",
		);
		if (!precommitted) commit(directory, "feature-file");
		const tip = git(directory, "rev-parse", "HEAD");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
		git(seed, "fetch", "-q", directory, "feature");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:02:00Z");
		git(seed, "merge", strategy, "-qm", "Merge feature", "FETCH_HEAD");
		git(seed, "push", "-q", remote, "trunk");
		git(directory, "fetch", "-q", "origin");
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedHead: tip,
		});
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:03:00Z");
		commit(seed, "later-default-work");
		git(seed, "push", "-q", remote, "trunk");
		git(directory, "fetch", "-q", "origin");
		expect(await readSessionGit(directory)).toMatchObject({
			merged: true,
			mergedHead: tip,
		});
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:04:00Z");
		git(directory, "checkout", "-qb", "fresh", "origin/trunk");
		expect(await readSessionGit(directory)).toMatchObject({ merged: false });
	});
	it("omits merged when no default ref exists", async () => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "branch", "-m", "topic");
		expect(await readSessionGit(directory)).not.toHaveProperty("merged");
	});
	it("reports a conflicted rebase", async () => {
		const directory = repo();
		writeFileSync(join(directory, "conflict"), "base\n");
		git(directory, "add", "conflict");
		git(directory, "commit", "-qm", "base");
		git(directory, "checkout", "-qb", "feature");
		writeFileSync(join(directory, "conflict"), "feature\n");
		git(directory, "commit", "-qam", "feature");
		git(directory, "checkout", "-q", "main");
		writeFileSync(join(directory, "conflict"), "main\n");
		git(directory, "commit", "-qam", "main");
		git(directory, "checkout", "-q", "feature");
		const rebase = spawnSync("git", ["rebase", "main"], { cwd: directory });
		expect(rebase.status).not.toBe(0);
		expect(await readSessionGit(directory)).toMatchObject({
			operation: "rebase",
		});
	});
	it("reads an empty repository without a head", async () => {
		expect(await readSessionGit(repo())).toEqual({
			branch: "main",
			dirty: false,
		});
	});
	it("counts staged and untracked files in an unborn branch without line totals", async () => {
		const directory = repo();
		writeFileSync(join(directory, "staged"), "staged\n");
		git(directory, "add", "staged");
		writeFileSync(join(directory, "untracked"), "untracked\n");
		expect(await readSessionGit(directory)).toEqual({
			branch: "main",
			dirty: true,
			changes: { files: 2, insertions: 0, deletions: 0 },
		});
	});
});

describe("previous session git state", () => {
	// Reflog expiry must not move a known merge time; a changed branch tip must
	// compute a new one, and an uncached fast-forward must fall back safely.
	it("reuses mergedAt for an unchanged merged head after its reflog expires", async () => {
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z");
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:01:00Z");
		commit(directory, "feature-file");
		git(directory, "checkout", "-q", "main");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:02:00Z");
		git(directory, "merge", "--ff-only", "-q", "feature");
		git(directory, "checkout", "-q", "feature");
		const previous = await readSessionGit(directory);
		const mergedAt = Date.parse("2026-01-01T00:02:00Z");
		expect(previous).toMatchObject({ mergedAt });
		git(directory, "reflog", "expire", "--expire=all", "refs/heads/main");
		expect(await readSessionGit(directory)).toMatchObject({
			mergedAt: Date.parse("2026-01-01T00:01:00Z"),
		});
		invalidateSessionGitRepository(join(directory, ".git"));
		expect(await readSessionGit(directory, previous)).toMatchObject({
			mergedAt,
		});
		expect(await readSessionGit(directory)).toMatchObject({
			mergedAt: Date.parse("2026-01-01T00:01:00Z"),
		});
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:03:00Z");
		commit(directory, "more-work");
		const unmerged = await readSessionGit(directory, previous);
		expect(unmerged).toMatchObject({ merged: false });
		expect(unmerged).not.toHaveProperty("mergedAt");
		git(directory, "checkout", "-q", "main");
		vi.stubEnv("GIT_COMMITTER_DATE", "2026-01-01T00:04:00Z");
		git(directory, "merge", "--ff-only", "-q", "feature");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory, unmerged)).toMatchObject({
			mergedAt: Date.parse("2026-01-01T00:04:00Z"),
		});
	});
});

// Destructive rechecks must observe moved or removed default refs and must keep
// a checkout when inspection fails or its head is not in any local default ref.
describe("hasNoCommitsBeyondDefault", () => {
	it("rechecks real default refs on every call, including remote HEAD", async () => {
		const directory = repo();
		commit(directory, "initial");
		const initial = git(directory, "rev-parse", "HEAD");
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		const head = git(directory, "rev-parse", "HEAD");
		const { owner } = subprocess();
		const check = () =>
			Effect.runPromise(
				hasNoCommitsBeyondDefault(directory, head).pipe(
					Effect.provideService(Subprocess, owner),
				),
			);
		expect(await check()).toBe(false);
		git(directory, "update-ref", "refs/heads/main", head);
		expect(await check()).toBe(true);
		git(directory, "update-ref", "refs/heads/main", initial);
		expect(await check()).toBe(false);
		git(directory, "branch", "-D", "main");
		git(
			directory,
			"symbolic-ref",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/trunk",
		);
		git(directory, "update-ref", "refs/remotes/origin/trunk", head);
		expect(await check()).toBe(true);
		git(directory, "update-ref", "refs/remotes/origin/trunk", initial);
		expect(await check()).toBe(false);
	});
	it("keeps non-git directories and repositories with no usable default head", async () => {
		expect(
			await Effect.runPromise(hasNoCommitsBeyondDefault(root(), "HEAD")),
		).toBe(false);
		expect(
			await Effect.runPromise(hasNoCommitsBeyondDefault(repo(), "HEAD")),
		).toBe(false);
	});
});
