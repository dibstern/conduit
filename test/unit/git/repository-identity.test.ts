// Failure modes (written before the tests and implementation):
// - scp-style SSH and ssh://, https:// and git:// URLs must identify one repo.
// - Explicit ports and userinfo must not become part of the key.
// - Trailing slashes and .git, host/owner/repo case, and nested groups must normalise.
// - Missing or malformed remotes must not invent a hosted identity; they use the git dir.
// - No origin uses the real shared git directory, including linked worktrees.
// - Subfolders and submodules must resolve their own repository toplevel.
// - Non-git, missing and bare folders have no working-tree identity.
// - Remote changes must be visible on the next read.
// - Inherited GIT_DIR/GIT_INDEX_FILE must not redirect discovery.
// - Missing git, git errors and timeouts must return no identity.
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	normalizeRepositoryRemote,
	readRepositoryIdentity,
} from "../../../src/lib/git/repository-identity.js";

describe("normalizeRepositoryRemote", () => {
	it.each([
		"git@GitHub.COM:Owner/Repo.git",
		"ssh://git@GitHub.COM/Owner/Repo.git",
		"ssh://git@GitHub.COM:2222/Owner/Repo.git/",
		"https://username:password@GitHub.COM:8443/Owner/Repo.git/",
		"git://GitHub.COM:9418/Owner/Repo/",
		"https://github.com/Owner/Repo.GIT///",
	])("collapses transport, authority and suffix differences in %s", (remote) => {
		expect(normalizeRepositoryRemote(remote)).toEqual({
			key: "github.com/owner/repo",
			name: "Repo",
		});
	});

	it("treats owner and repository case as insignificant for keys", () => {
		expect(
			normalizeRepositoryRemote("git@github.com:OWNER/REPO.git")?.key,
		).toBe(normalizeRepositoryRemote("https://github.com/owner/repo")?.key);
	});

	it("keeps nested groups", () => {
		expect(
			normalizeRepositoryRemote("ssh://git@GitLab.COM/Group/Sub/Repo.git"),
		).toEqual({
			key: "gitlab.com/group/sub/repo",
			name: "Repo",
		});
	});

	it.each([
		"",
		"/tmp/repo.git",
		"../repo",
		"file:///tmp/repo.git",
		"https://github.com",
		"https://github.com/owner/",
		"git@github.com:",
		"https://github.com/owner//repo",
		"https://github.com/owner/repo?token=secret",
		"not a remote",
	])("returns none for an unsupported or malformed remote %s", (remote) =>
		expect(normalizeRepositoryRemote(remote)).toBeUndefined());
});

describe("readRepositoryIdentity", () => {
	let directory: string;
	let repo: string;
	const git = (cwd: string, ...args: string[]) => {
		const env = { ...process.env };
		delete env["GIT_DIR"];
		delete env["GIT_INDEX_FILE"];
		return execFileSync("git", args, {
			cwd,
			env,
			encoding: "utf8",
			stdio: "pipe",
			timeout: 5000,
		}).trim();
	};

	beforeEach(() => {
		directory = realpathSync(
			mkdtempSync(join(tmpdir(), "repository-identity-")),
		);
		repo = join(directory, "local");
		mkdirSync(repo);
		git(repo, "init", "-q");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("uses the absolute realpath of the common dir with no origin", async () => {
		const alias = join(directory, "alias");
		symlinkSync(repo, alias, "dir");
		expect(await readRepositoryIdentity(alias)).toEqual({
			key: realpathSync(join(repo, ".git")),
			name: "local",
			root: repo,
		});
	});

	it("shares the no-origin key and name with a linked worktree", async () => {
		git(
			repo,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-qm",
			"initial",
		);
		const linked = join(directory, "linked");
		git(repo, "worktree", "add", "-qb", "linked", linked);
		const identity = await readRepositoryIdentity(repo);
		expect(identity).toEqual({
			key: join(repo, ".git"),
			name: "local",
			root: repo,
		});
		expect(await readRepositoryIdentity(linked)).toEqual({
			...identity,
			root: linked,
		});
	});

	it("uses the repository root when the project folder is a subfolder", async () => {
		const folder = join(repo, "packages", "one");
		mkdirSync(folder, { recursive: true });
		git(repo, "remote", "add", "origin", "git@github.com:Owner/Repo.git");
		expect(await readRepositoryIdentity(folder)).toEqual({
			key: "github.com/owner/repo",
			name: "Repo",
			root: repo,
		});
	});

	it("identifies a submodule separately from its parent", async () => {
		const source = join(directory, "submodule-source");
		mkdirSync(source);
		git(source, "init", "-q");
		git(
			source,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"--allow-empty",
			"-qm",
			"initial",
		);
		git(
			repo,
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"add",
			"-q",
			source,
			"child",
		);
		const child = join(repo, "child");
		git(
			child,
			"remote",
			"set-url",
			"origin",
			"https://gitlab.com/Group/Sub/Child.git",
		);
		expect(await readRepositoryIdentity(child)).toEqual({
			key: "gitlab.com/group/sub/child",
			name: "Child",
			root: child,
		});
		git(child, "remote", "remove", "origin");
		expect((await readRepositoryIdentity(child))?.key).toBe(
			realpathSync(join(repo, ".git", "modules", "child")),
		);
	});

	it("returns none for non-git, missing and bare folders", async () => {
		const bare = join(directory, "bare.git");
		git(directory, "init", "--bare", "-q", bare);
		for (const folder of [directory, join(directory, "missing"), bare])
			expect(await readRepositoryIdentity(folder)).toBeUndefined();
	});

	it("refreshes the remote and falls back to the git dir when a configured origin is invalid", async () => {
		git(repo, "remote", "add", "origin", "git@github.com:Owner/Before.git");
		expect((await readRepositoryIdentity(repo))?.key).toBe(
			"github.com/owner/before",
		);
		git(
			repo,
			"remote",
			"set-url",
			"origin",
			"https://gitlab.com/Group/After.git",
		);
		expect(await readRepositoryIdentity(repo)).toEqual({
			key: "gitlab.com/group/after",
			name: "After",
			root: repo,
		});
		git(repo, "remote", "set-url", "origin", "not a remote");
		expect((await readRepositoryIdentity(repo))?.key).toBe(join(repo, ".git"));
	});

	it("unsets inherited git directory and index variables", async () => {
		vi.stubEnv("GIT_DIR", join(directory, "missing.git"));
		vi.stubEnv("GIT_INDEX_FILE", join(directory, "missing-index"));
		expect(await readRepositoryIdentity(repo)).toEqual({
			key: join(repo, ".git"),
			name: "local",
			root: repo,
		});
	});

	it("returns none when git is missing or fails", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(repo, ".git", "config"), "[malformed config\n");
		expect(await readRepositoryIdentity(repo)).toBeUndefined();
		vi.stubEnv("PATH", dirname(join(directory, "missing", "git")));
		expect(await readRepositoryIdentity(repo)).toBeUndefined();
	});

	it("times out git without failing discovery", async () => {
		const { chmodSync, writeFileSync } = await import("node:fs");
		const bin = join(directory, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 30\n");
		chmodSync(join(bin, "git"), 0o755);
		vi.stubEnv("PATH", bin);
		const started = Date.now();
		expect(await readRepositoryIdentity(repo)).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(5000);
	}, 7000);
});
