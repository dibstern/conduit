// Failure modes: a base set on one client never reaches another, or reaches it
// only after a reload; the override is held in daemon memory and a restart
// drops it; the listing ignores the override and keeps the default branch's
// revision; clearing it leaves the old base in force; resolving refs writes
// the user's index, objects or refs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionDiffListing } from "../../../src/lib/contracts/session-diff.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const GIT_KEYS = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
];
const gitEnv = { ...process.env };
for (const key of GIT_KEYS) delete gitEnv[key];

const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

const commit = (repo: string, message: string) => {
	git(repo, "add", ".");
	git(
		repo,
		"-c",
		"user.name=Diff test",
		"-c",
		"user.email=diff@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-m",
		message,
	);
};

/** Content hash of every file that records the repository's state. */
function repositoryBytes(gitDir: string) {
	const hashes: Record<string, string> = {};
	const walk = (path: string) => {
		if (!existsSync(path)) return;
		if (statSync(path).isDirectory()) {
			for (const name of readdirSync(path)) walk(join(path, name));
			return;
		}
		hashes[relative(gitDir, path)] = createHash("sha256")
			.update(readFileSync(path))
			.digest("hex");
	};
	for (const name of ["index", "objects", "refs", "packed-refs", "HEAD"])
		walk(join(gitDir, name));
	return hashes;
}

const summary = ({ revision, folders: [folder] }: SessionDiffListing) => {
	if (!folder || !("files" in folder)) throw new Error("Missing folder");
	return {
		revision,
		base: folder.base,
		files: folder.files.map(({ status, path }) => `${status} ${path}`),
	};
};

/** The diffBase a browser's session list shows for the session, once it equals `base`. */
const rowBase = async (
	browser: ProcessBrowser,
	sessionId: string,
	base: string | null,
) => {
	const row = await browser.waitFor(
		(message) =>
			message["type"] === "session_row" &&
			message["id"] === sessionId &&
			(message["diffBase"] ?? null) === base,
	);
	const shown = row["diffBase"];
	return typeof shown === "string" ? shown : null;
};

describe("Session diff base override through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	const evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		if (task.result?.errors?.length) evidence["logs"] = fixture.logTail;
		const root = realpathSync(fixture.root);
		try {
			await fixture.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/f02e9-4-session-diff-base.json",
				`${JSON.stringify(evidence, null, 2).replaceAll(root, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("shares a base set on one client with another, keeps it across a restart, and leaves the repository untouched", async () => {
		for (const key of GIT_KEYS) vi.stubEnv(key, undefined);
		harness = ProcessHarness.create({
			managedOpenCode: true,
			claudeReplay: { turns: ["pong-thinking-text-turn"], delayMs: 0 },
		});
		const fixture = harness;
		const repo = fixture.projectDir;
		git(repo, "init", "-b", "main");
		writeFileSync(join(repo, "shared.txt"), "one\n");
		commit(repo, "Initial commit");
		git(repo, "checkout", "-b", "feature");
		writeFileSync(join(repo, "feature.txt"), "feature\n");
		commit(repo, "Feature commit");
		writeFileSync(join(repo, "shared.txt"), "one\nuncommitted\n");
		writeFileSync(join(repo, "untracked.txt"), "new\n");
		const gitDir = join(repo, ".git");
		const before = repositoryBytes(gitDir);

		await fixture.restart();
		const run = <A, E>(effect: Effect.Effect<A, E>) =>
			Effect.runPromise(effect);
		const clientA = await fixture.connect();
		const clientB = await fixture.connect();
		const sessionId = await clientA.createSession("Diff base");
		const list = (browser: ProcessBrowser, base: string | null) =>
			run(
				browser.rpc.SessionDiffList({
					sessionId,
					scope: { kind: "branch", base },
				}),
			).then(summary);

		// No worktree, no override: the default branch is the base.
		const initial = await list(
			clientB,
			await rowBase(clientB, sessionId, null),
		);
		evidence["initial"] = initial;
		expect(initial.base).toEqual({
			ref: "main",
			source: "default",
			kind: "branch",
		});
		expect(initial.files).toEqual([
			"added feature.txt",
			"modified shared.txt",
			"added untracked.txt",
		]);

		await run(clientA.rpc.SetSessionDiffBase({ sessionId, base: "feature" }));
		const shared = await list(
			clientB,
			await rowBase(clientB, sessionId, "feature"),
		);
		evidence["shared"] = shared;
		expect(shared.base).toEqual({
			ref: "feature",
			source: "override",
			kind: "branch",
		});
		expect(shared.files).toEqual([
			"modified shared.txt",
			"added untracked.txt",
		]);
		expect(shared.revision).not.toBe(initial.revision);

		await fixture.terminate();
		await fixture.restart();
		const reloaded = await fixture.connect();
		const restored = await rowBase(reloaded, sessionId, "feature");
		evidence["restoredBase"] = restored;
		expect((await list(reloaded, restored)).revision).toBe(shared.revision);

		await run(reloaded.rpc.SetSessionDiffBase({ sessionId, base: null }));
		const cleared = await list(
			reloaded,
			await rowBase(reloaded, sessionId, null),
		);
		evidence["cleared"] = cleared;
		expect(cleared).toEqual(initial);

		const after = repositoryBytes(gitDir);
		evidence["repositoryUnchanged"] =
			JSON.stringify(after) === JSON.stringify(before);
		expect(after).toEqual(before);
	});
});
