// Failure modes: only the focused project holds Interests, so another listed
// project's folder is never refreshed; refresh waits for a list RPC that the
// open shell never sends; the shell never re-emits projects after git moves;
// the shell's project Interests never reach the git scheduler, so a nested
// edit (no ref or directory stamp moves) waits for the dormant tier forever.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "effect";
import { afterEach, expect, it } from "vitest";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// A ref change is caught by the listed probe (5s, dormant is 10s). A nested
// edit moves no stamp, so it waits for the listed interval (30s) and then the
// daemon-wide safety net, one oldest folder per 20s across both listed folders.
const COMMIT_BUDGET_MS = 15_000;
const EDIT_BUDGET_MS = 30_000 + 2 * 20_000 + 5_000;
const gitEnv = { ...process.env };
for (const key of [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
])
	delete gitEnv[key];
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

let harness: ProcessHarness | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

// test-waits-allow timeout-override: the listed cadence runs on the real daemon's wall clock, up to 75s.
it("refreshes an unfocused project's git in the open shell after a commit and a nested edit", async () => {
	harness = ProcessHarness.create({ logLevel: "warn" });
	const other = join(harness.root, "other-project");
	mkdirSync(other);
	for (const directory of [harness.projectDir, other]) {
		git(directory, "init", "-q", "-b", "main");
		git(directory, "config", "user.name", "Project git fixture");
		git(directory, "config", "user.email", "project-git@example.test");
		git(directory, "config", "core.hooksPath", "/dev/null");
		mkdirSync(join(directory, "nested"));
		writeFileSync(join(directory, "nested", "file.txt"), "one\n");
		git(directory, "add", ".");
		git(directory, "commit", "-q", "-m", "Initial");
	}
	const config = Result.getOrThrow(loadDaemonConfigResult(harness.configDir));
	writeFileSync(
		join(harness.configDir, "daemon.json"),
		JSON.stringify({
			...config,
			projects: [
				{
					path: harness.projectDir,
					folders: [harness.projectDir],
					slug: "process-test",
					addedAt: 1,
				},
				{ path: other, folders: [other], slug: "other-project", addedAt: 2 },
			],
		}),
	);
	await harness.restart();
	const browser = await harness.connect(
		undefined,
		undefined,
		"process-test",
		false,
	);
	type ProjectsFrame = {
		projects?: { slug: string; git?: { head?: string; dirty?: boolean } }[];
	};
	const otherGit = (message: Record<string, unknown>) =>
		message["type"] === "shell" && message["_tag"] === "projects"
			? (message as ProjectsFrame).projects?.find(
					({ slug }) => slug === "other-project",
				)?.git
			: undefined;
	const visibleMs = (
		predicate: (git: { head?: string; dirty?: boolean }) => boolean,
		budgetMs: number,
	) => {
		const startedAt = performance.now();
		return browser
			.waitFor(
				(message) => {
					const git = otherGit(message);
					return git !== undefined && predicate(git);
				},
				browser.frames.length,
				budgetMs,
			)
			.then(
				() => Math.round(performance.now() - startedAt),
				() => null,
			);
	};
	const latest = () =>
		browser.frames
			.map(({ message }) => otherGit(message))
			.filter(Boolean)
			.at(-1);
	const initial = git(other, "rev-parse", "--short", "HEAD");
	await browser.waitFor((message) => otherGit(message)?.head === initial);

	git(other, "commit", "-q", "--allow-empty", "-m", "External commit");
	const head = git(other, "rev-parse", "--short", "HEAD");
	const commitMs = await visibleMs(
		(git) => git.head === head,
		COMMIT_BUDGET_MS,
	);
	writeFileSync(join(other, "nested", "file.txt"), "two\n");
	const editMs = await visibleMs((git) => git.dirty === true, EDIT_BUDGET_MS);
	const result = {
		expectedHead: head,
		observedHead: latest()?.head ?? null,
		commitVisibleMs: commitMs,
		observedDirty: latest()?.dirty ?? null,
		nestedEditVisibleMs: editMs,
		commitBudgetMs: COMMIT_BUDGET_MS,
		editBudgetMs: EDIT_BUDGET_MS,
	};
	mkdirSync("test-results", { recursive: true });
	writeFileSync(
		"test-results/project-list-git-refresh.json",
		`${JSON.stringify(result, null, 2)}\n`,
	);
	expect(result).toMatchObject({ observedHead: head, observedDirty: true });
}, 150_000);
