import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSessionGitCache,
	readSessionGit,
} from "../../../src/lib/git/session-git.js";

const roots: string[] = [];
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
	return git(directory, "rev-parse", "--short", "HEAD");
};

afterEach(() => {
	for (const directory of roots.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("readSessionGit", () => {
	it("returns undefined outside a repository", async () => {
		expect(await readSessionGit(root())).toBeUndefined();
	});
	it("reads a named branch and its short head", async () => {
		const directory = repo();
		const head = commit(directory, "initial");
		expect(await readSessionGit(directory)).toMatchObject({
			branch: "main",
			head,
			merged: false,
		});
	});
	it("omits the branch for detached HEAD", async () => {
		const directory = repo();
		const head = commit(directory, "initial");
		git(directory, "checkout", "--detach", "-q");
		expect(await readSessionGit(directory)).toEqual({ head });
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
	])("marks a feature merged via %s", async (strategy) => {
		const directory = repo();
		commit(directory, "initial");
		git(directory, "checkout", "-qb", "feature");
		commit(directory, "feature-file");
		git(directory, "checkout", "-q", "main");
		git(directory, "merge", strategy, "-q", "feature");
		git(directory, "checkout", "-q", "feature");
		expect(await readSessionGit(directory)).toMatchObject({
			branch: "feature",
			merged: true,
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
	it("prefers a resolving origin HEAD over local main", async () => {
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
		expect(await readSessionGit(repo())).toEqual({ branch: "main" });
	});
});

describe("createSessionGitCache", () => {
	it("shares one in-flight read and keeps peek synchronous", async () => {
		let finish: (value: { branch: string }) => void = () => {
			throw new Error("not started");
		};
		const read = vi.fn(
			() =>
				new Promise<{ branch: string }>((resolve) => {
					finish = resolve;
				}),
		);
		const cache = createSessionGitCache(read);
		const first = cache.refresh("/project");
		const second = cache.refresh("/project");
		expect(read).toHaveBeenCalledTimes(1);
		expect(cache.peek("/project")).toBeUndefined();
		finish({ branch: "main" });
		expect(await first).toEqual({ branch: "main" });
		expect(await second).toEqual({ branch: "main" });
		expect(cache.peek("/project")).toEqual({ branch: "main" });
	});
});
