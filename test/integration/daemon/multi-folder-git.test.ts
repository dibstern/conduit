import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GetProjects,
	ListDaemonSessions,
	MoveSessionWorkspace,
	SaveProject,
	SessionInfoSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { SessionGit } from "../../../src/lib/shared-types.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure modes: only primary git is sent; secondary changes reuse primary
// dirty/upstream state or never reach shell/family streams; non-git breaks the
// read; cold project lists lack branches; workspaces read the main checkouts;
// detached HEAD is lost; labels change to worktree names; restart loses mapping.
// A non-git primary hides a sole git extra; detaching a mapped folder freezes
// the legacy checkout fields even though the provider still uses that worktree.
const git = (directory: string, ...args: string[]) =>
	execFileSync("git", ["-C", directory, ...args], {
		encoding: "utf8",
		stdio: "pipe",
	}).trim();

function commit(directory: string, message: string) {
	git(
		directory,
		"-c",
		"user.name=Folder git test",
		"-c",
		"user.email=git@example.test",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--allow-empty",
		"-m",
		message,
	);
}

function latestGit(
	browser: ProcessBrowser,
	feed: "shell" | "family",
	id: string,
) {
	return browser.frames
		.flatMap(({ message }) => {
			if (message["type"] !== feed) return [];
			const rows =
				message["_tag"] === "snapshot" && Array.isArray(message["rows"])
					? message["rows"]
					: message["_tag"] === "upsert"
						? [message["item"]]
						: [];
			return rows
				.filter(Schema.is(SessionInfoSchema))
				.filter((row) => row.id === id);
		})
		.at(-1)?.git;
}

const normalizedGit = (state: SessionGit | undefined) =>
	state?.folders?.map(({ root, label, branch, dirty, ahead, behind }) => ({
		root,
		label,
		branch: branch ?? "detached",
		dirty,
		ahead: ahead ?? null,
		behind: behind ?? null,
	}));

describe("Multi-folder git through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create({
			managedOpenCode: true,
			claudeReplay: { turns: ["pong-thinking-text-turn"], delayMs: 0 },
		});
		const fixture = harness;
		const secondary = join(fixture.root, "library");
		const scratch = join(fixture.root, "notes");
		mkdirSync(secondary);
		mkdirSync(scratch);
		for (const [directory, branch, repo] of [
			[fixture.projectDir, "feature/web", "Frontend"],
			[secondary, "feature/api", "Backend"],
		] as const) {
			git(directory, "init", "-b", branch);
			git(
				directory,
				"remote",
				"add",
				"origin",
				`git@example.test:team/${repo}.git`,
			);
			writeFileSync(join(directory, "tracked.txt"), "initial\n");
			git(directory, "add", "tracked.txt");
			commit(directory, "Initial commit");
			git(directory, "branch", "upstream");
			git(directory, "branch", "--set-upstream-to=upstream", branch);
		}
		// Divergence is local: no fetch, credentials or external repository.
		git(secondary, "checkout", "upstream");
		commit(secondary, "Upstream only");
		git(secondary, "checkout", "feature/api");
		commit(secondary, "Local only");
		await fixture.restart();
		const socket = join(fixture.configDir, "relay.sock");
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, secondary, scratch],
			}),
		);
		return { fixture, socket, secondary, scratch };
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const realRoot = realpathSync(fixture.root);
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message) ?? [];
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
			evidence["cleanup"] = "no runners remain";
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/q5u6-15-${scenario}.json`,
				`${JSON.stringify(evidence, null, 2).replaceAll(realRoot, "<root>").replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("reports each repository, independent dirty/upstream state and detached HEAD through live and cold reads", async () => {
		const { fixture, socket, secondary, scratch } = await start("status");
		const projects = await sendRpcRequest(socket, new GetProjects({}));
		const project = projects.projects.find(
			({ slug }) => slug === "process-test",
		);
		expect(project?.repositoryIdentities?.[fixture.projectDir]?.name).toBe(
			"Frontend",
		);
		expect(project?.repositoryIdentities?.[secondary]?.name).toBe("Backend");
		expect(project?.repositoryIdentities).not.toHaveProperty(scratch);
		expect(project?.git?.folders).toMatchObject([
			{
				root: fixture.projectDir,
				label: basename(fixture.projectDir),
				branch: "feature/web",
				dirty: false,
				ahead: 0,
				behind: 0,
			},
			{
				root: secondary,
				label: "library",
				branch: "feature/api",
				dirty: false,
				ahead: 1,
				behind: 1,
			},
		]);
		evidence["projectFolders"] = normalizedGit(project?.git);
		evidence["repositories"] = project?.repositoryIdentities;
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Git folders");
		await browser.followFamily(sessionId);
		await vi.waitFor(
			() => {
				for (const feed of ["shell", "family"] as const) {
					const state = latestGit(browser, feed, sessionId);
					expect(state?.branch).toBe("feature/web");
					expect(state?.folders).toHaveLength(2);
					expect(state?.folders?.map(({ branch }) => branch)).toEqual([
						"feature/web",
						"feature/api",
					]);
				}
			},
			{ timeout: 20_000 },
		);
		writeFileSync(join(secondary, "tracked.txt"), "secondary changed\n");
		// No read RPC forces the update: the existing poller must publish it.
		await vi.waitFor(
			() => {
				for (const feed of ["shell", "family"] as const)
					expect(
						latestGit(browser, feed, sessionId)?.folders?.map(
							({ dirty }) => dirty,
						),
					).toEqual([false, true]);
			},
			{ timeout: 20_000 },
		);
		for (const feed of ["shell", "family"] as const)
			evidence[feed] = normalizedGit(latestGit(browser, feed, sessionId));
		const list = await sendRpcRequest(
			socket,
			new ListDaemonSessions({ scope: "process-test" }),
		);
		evidence["daemonList"] = normalizedGit(
			list.sessions.find(({ id }) => id === sessionId)?.git,
		);
		expect(evidence["daemonList"]).toEqual(evidence["shell"]);
		git(secondary, "checkout", "--detach");
		await vi.waitFor(
			() => {
				const secondaryGit = latestGit(browser, "shell", sessionId)
					?.folders?.[1];
				expect(secondaryGit?.branch).toBeUndefined();
				expect(secondaryGit?.head).toMatch(/^[a-f0-9]+$/);
			},
			{ timeout: 20_000 },
		);
		evidence["detached"] = normalizedGit(
			latestGit(browser, "shell", sessionId),
		);
	});

	it("reports a sole git extra when the primary folder is not git", async () => {
		const { fixture, socket, secondary, scratch } =
			await start("non-git-primary");
		await sendRpcRequest(
			socket,
			new SaveProject({ slug: "process-test", folders: [scratch, secondary] }),
		);
		writeFileSync(join(secondary, "tracked.txt"), "git extra changed\n");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Non-git primary");
		await browser.followFamily(sessionId);
		await vi.waitFor(
			() => {
				for (const feed of ["shell", "family"] as const) {
					const state = latestGit(browser, feed, sessionId);
					expect(state?.branch).toBeUndefined();
					expect(state?.dirty).toBeUndefined();
					expect(state?.folders).toHaveLength(1);
					expect(state?.folders?.[0]).toMatchObject({
						root: secondary,
						label: "library",
						branch: "feature/api",
						dirty: true,
						ahead: 1,
						behind: 1,
					});
				}
			},
			{ timeout: 20_000 },
		);
		for (const feed of ["shell", "family"] as const)
			evidence[feed] = normalizedGit(latestGit(browser, feed, sessionId));
	});

	it("keeps refreshing the legacy checkout after detaching its mapped folder", async () => {
		const { fixture, socket, secondary, scratch } =
			await start("detached-folder");
		const worktree = join(fixture.root, "api-worktree");
		git(secondary, "worktree", "add", "-b", "feature/isolated", worktree);
		const original = await fixture.connect();
		const sessionId = await original.createSession("Detached mapped folder");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: worktree,
			}),
		);
		await sendRpcRequest(
			socket,
			new SaveProject({
				slug: "process-test",
				folders: [fixture.projectDir, scratch],
			}),
		);
		const browser = await fixture.connect();
		await browser.followFamily(sessionId);
		writeFileSync(
			join(worktree, "tracked.txt"),
			"effective checkout changed\n",
		);
		await vi.waitFor(
			() => {
				for (const feed of ["shell", "family"] as const) {
					const state = latestGit(browser, feed, sessionId);
					expect(state?.branch).toBe("feature/isolated");
					expect(state?.dirty).toBe(true);
					expect(state?.folders).toHaveLength(1);
					expect(state?.folders?.[0]).toMatchObject({
						root: fixture.projectDir,
						branch: "feature/web",
						dirty: false,
					});
				}
			},
			{ timeout: 20_000 },
		);
		for (const feed of ["shell", "family"] as const) {
			const state = latestGit(browser, feed, sessionId);
			evidence[feed] = {
				branch: state?.branch,
				dirty: state?.dirty,
				folders: normalizedGit(state),
			};
		}
		await fixture.shutdown();
		await fixture.restart();
		const list = await sendRpcRequest(
			socket,
			new ListDaemonSessions({ scope: "process-test" }),
		);
		const restored = list.sessions.find(({ id }) => id === sessionId)?.git;
		expect(restored?.branch).toBe("feature/isolated");
		expect(restored?.dirty).toBe(true);
		expect(restored?.folders).toHaveLength(1);
		evidence["afterRestart"] = {
			branch: restored?.branch,
			dirty: restored?.dirty,
			folders: normalizedGit(restored),
		};
	}, 60_000);

	it("reads the secondary effective worktree, keeps project branches separate and survives restart", async () => {
		const { fixture, socket, secondary } = await start("workspace");
		const worktree = join(fixture.root, "api-worktree");
		git(secondary, "worktree", "add", "-b", "feature/isolated", worktree);
		writeFileSync(join(secondary, "tracked.txt"), "main checkout dirty\n");
		const browser = await fixture.connect();
		const sessionId = await browser.createSession("Mapped git folders");
		await sendRpcRequest(
			socket,
			new MoveSessionWorkspace({
				projectSlug: "process-test",
				sessionId,
				path: worktree,
			}),
		);
		const list = () =>
			sendRpcRequest(socket, new ListDaemonSessions({ scope: "process-test" }));
		await vi.waitFor(
			async () => {
				const session = (await list()).sessions.find(
					({ id }) => id === sessionId,
				);
				expect(session?.git?.folders).toMatchObject([
					{
						root: fixture.projectDir,
						label: basename(fixture.projectDir),
						branch: "feature/web",
						dirty: false,
					},
					{
						root: secondary,
						label: "library",
						branch: "feature/isolated",
						dirty: false,
					},
				]);
				// Keep the existing single moved-folder checkout compatibility fields.
				expect(session?.git?.branch).toBe("feature/isolated");
			},
			{ timeout: 20_000 },
		);
		evidence["workspace"] = normalizedGit(
			(await list()).sessions.find(({ id }) => id === sessionId)?.git,
		);
		await vi.waitFor(
			async () => {
				const project = (
					await sendRpcRequest(socket, new GetProjects({}))
				).projects.find(({ slug }) => slug === "process-test");
				expect(project?.git?.folders?.[1]).toMatchObject({
					branch: "feature/api",
					dirty: true,
				});
				evidence["projectFolders"] = normalizedGit(project?.git);
			},
			{ timeout: 20_000 },
		);
		await fixture.shutdown();
		await fixture.restart();
		const restored = (await list()).sessions.find(({ id }) => id === sessionId);
		expect(normalizedGit(restored?.git)).toEqual(evidence["workspace"]);
		evidence["afterRestart"] = normalizedGit(restored?.git);
	});
});
