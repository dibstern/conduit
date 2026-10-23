import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

interface WorkspaceObservation {
	sessionId: string;
	owner: number;
	directory: string;
	requestedPath: string;
}

// Failures: each relay constructs an owner; a retained owner borrows another
// project's root, worktree mapping, or pending Claude move; relay replacement
// discards that owner. All Git repositories and processes belong to the fixture.
// A held rename must block only its project; removal must retire its permit,
// including while held, and empty/no-project calls must not retain a slug.
describe("daemon-owned SessionWorkspace", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	beforeEach(() => {
		evidence = {};
	});
	const observations = (): WorkspaceObservation[] => {
		if (!harness) return [];
		const path = join(harness.root, "daemon-session-workspace.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as WorkspaceObservation)
			: [];
	};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const calls = observations();
		const logs = fixture.logTail;
		try {
			for (const gate of (evidence["gates"] as string[] | undefined) ?? [])
				writeFileSync(`${gate}-release`, "cleanup");
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			vi.unstubAllEnvs();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/82tn-10-3-daemon-session-workspace${evidence["scenario"] ? `-${evidence["scenario"]}` : ""}.json`,
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.3",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						calls,
						logs,
						cleanup: fixture.proof(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	it("lets B prewarm and send while A's rename holds its own sends", async () => {
		const fixture = ProcessHarness.create();
		harness = fixture;
		evidence = { scenario: "project-launch-isolation" };
		const projectB = join(fixture.root, "project-b");
		const gitEnv = { ...process.env };
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		]) {
			delete gitEnv[key];
			vi.stubEnv(key, undefined);
		}
		for (const directory of [fixture.projectDir, projectB]) {
			mkdirSync(directory, { recursive: true });
			for (const args of [
				["init", "-b", "main", directory],
				[
					"-C",
					directory,
					"-c",
					"user.name=Workspace test",
					"-c",
					"user.email=workspace@example.test",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"--allow-empty",
					"-m",
					"Fixture",
				],
			])
				execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
		}
		const realGit = execFileSync("/usr/bin/which", ["git"], {
			env: gitEnv,
			encoding: "utf8",
		}).trim();
		const shim = join(fixture.root, "git-shim");
		mkdirSync(shim);
		const paused = join(fixture.root, "rename-paused");
		const release = join(fixture.root, "release-rename");
		writeFileSync(
			join(shim, "git"),
			`#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("branch") && args.includes("-m") && args.includes("paused-rename")) {
  writeFileSync(${JSON.stringify(paused)}, "held");
  const deadline = Date.now() + 20_000;
  while (!existsSync(${JSON.stringify(release)})) {
    if (Date.now() > deadline) process.exit(1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${shim}:${gitEnv["PATH"] ?? ""}`);
		await fixture.restart();
		await fixture.requestRpc({ _tag: "SaveProject", folders: [projectB] });
		const { sessionId: sessionA } = await fixture.requestRpc({
			_tag: "CreateSession",
			projectSlug: "process-test",
			originId: "launch-isolation",
			providerId: "claude",
			model: { providerId: "claude", modelId: "sonnet" },
			permissionMode: "ask",
			title: "Project A",
			newWorktree: true,
		});
		const a = await fixture.connect(sessionA);
		await a.preWarmSession(sessionA);
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionB = await b.createSession("Project B");
		// Exclude cold runner startup from the bounded launch-lock check.
		await b.preWarmSession(sessionB);
		let renameFinished = false;
		let aFinished = false;
		const rename = fixture
			.requestRpc({
				_tag: "RenameSessionBranch",
				projectSlug: "process-test",
				sessionId: sessionA,
				branchName: "paused-rename",
			})
			.then(() => {
				renameFinished = true;
			});
		let sendA: ReturnType<typeof a.send> | undefined;
		try {
			await vi.waitFor(() => expect(existsSync(paused)).toBe(true), {
				timeout: 5_000,
			});
			sendA = a.send(sessionA, "Same project waits", 15_000).then((result) => {
				aFinished = true;
				return result;
			});
			const started = performance.now();
			await b.preWarmSession(sessionB, 2_000);
			evidence["prewarmMs"] = performance.now() - started;
			const sent = await b.send(sessionB, "Other project proceeds", 3_000);
			expect(sent.chunks.join("")).toBe(
				responseChunks("Other project proceeds").join(""),
			);
			evidence["bChunks"] = sent.chunks;
			evidence["bCompletedBeforeRelease"] = !renameFinished;
			evidence["aWaitedForRename"] = !aFinished;
			expect(renameFinished).toBe(false);
			expect(aFinished).toBe(false);
			expect(
				fixture.marks.some(
					(mark) =>
						mark.kind === "enqueue" && mark.prompt === "Same project waits",
				),
			).toBe(false);
		} finally {
			writeFileSync(release, "release");
			await Promise.all([rename, sendA]);
		}
		expect(aFinished).toBe(true);
		evidence["aCompletedAfterRelease"] = aFinished;
	}, 60_000);

	it("retires a removed project's held permit and fences old completion after re-add", async () => {
		const fixture = ProcessHarness.create();
		harness = fixture;
		evidence = { scenario: "project-launch-removal", gates: [] };
		writeFileSync(join(fixture.root, "daemon-session-workspace-proof"), "");
		await fixture.restart();
		const a = await fixture.connect();
		const oldSession = await a.createSession("Old registration");
		const oldGate = join(fixture.root, `workspace-launch-${oldSession}`);
		evidence["gates"] = [oldGate];
		writeFileSync(oldGate, "project");
		await a.preWarmSession(oldSession);
		await vi.waitFor(() => expect(existsSync(`${oldGate}-started`)).toBe(true));
		await fixture.requestRpc({ _tag: "RemoveProject", slug: "process-test" });
		expect(existsSync(`${oldGate}-finished`)).toBe(false);
		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			folders: [fixture.projectDir],
		});
		expect(saved.savedSlug).toBe("process-test");
		const replacement = await fixture.connect(
			undefined,
			undefined,
			"process-test",
		);
		const newSession = await replacement.createSession("New registration");
		const newGate = join(fixture.root, `workspace-launch-${newSession}`);
		evidence["gates"] = [oldGate, newGate];
		writeFileSync(newGate, "project");
		await replacement.preWarmSession(newSession);
		await vi.waitFor(() => expect(existsSync(`${newGate}-started`)).toBe(true));
		evidence["replacementAcquiredWhileOldHeld"] = !existsSync(
			`${oldGate}-finished`,
		);
		writeFileSync(`${oldGate}-release`, "release old generation");
		await vi.waitFor(() =>
			expect(existsSync(`${oldGate}-finished`)).toBe(true),
		);
		let finished = false;
		const send = replacement
			.send(newSession, "Replacement still owns its permit")
			.then((result) => {
				finished = true;
				return result;
			});
		try {
			await new Promise((done) => setTimeout(done, 200));
			expect(finished).toBe(false);
			evidence["oldCompletionPreservedReplacementPermit"] = !finished;
		} finally {
			writeFileSync(`${newGate}-release`, "release replacement");
			await send;
		}
		evidence["replacementCompleted"] = finished;
	}, 60_000);

	it("serializes a daemon retention callback with its captured project", async () => {
		const fixture = ProcessHarness.create();
		harness = fixture;
		evidence = { scenario: "daemon-retention-launch", gates: [] };
		writeFileSync(join(fixture.root, "daemon-session-workspace-proof"), "");
		writeFileSync(join(fixture.root, "workspace-retention-proof"), "");
		await fixture.restart();
		const a = await fixture.connect();
		const session = await a.createSession("Retention owner");
		const gate = join(fixture.root, `workspace-launch-${session}`);
		evidence["gates"] = [gate];
		writeFileSync(gate, "project");
		await a.preWarmSession(session);
		await vi.waitFor(() => expect(existsSync(`${gate}-started`)).toBe(true));
		await vi.waitFor(() =>
			expect(existsSync(`${gate}-retention-started`)).toBe(true),
		);
		expect(existsSync(`${gate}-retention-finished`)).toBe(false);
		evidence["retentionWaitedForProjectPermit"] = true;
		writeFileSync(`${gate}-release`, "release project");
		await vi.waitFor(() =>
			expect(existsSync(`${gate}-retention-finished`)).toBe(true),
		);
		evidence["retentionCompletedAfterRelease"] = true;
	});

	it.each([
		"no-project",
		"empty-project",
	])("keeps a %s caller separate from registered projects", async (mode) => {
		const fixture = ProcessHarness.create();
		harness = fixture;
		evidence = { scenario: `${mode}-launch`, gates: [] };
		writeFileSync(join(fixture.root, "daemon-session-workspace-proof"), "");
		await fixture.restart();
		const a = await fixture.connect();
		const session = await a.createSession("No project caller");
		const next = await fixture.connect();
		const other = await next.createSession("Registered project");
		await next.preWarmSession(other);
		const gate = join(fixture.root, `workspace-launch-${session}`);
		evidence["gates"] = [gate];
		writeFileSync(gate, mode);
		await a.preWarmSession(session);
		await vi.waitFor(() => expect(existsSync(`${gate}-started`)).toBe(true));
		await next.preWarmSession(other, 2_000);
		await next.send(
			other,
			"A context-free permit cannot block a project",
			3_000,
		);
		expect(existsSync(`${gate}-finished`)).toBe(false);
		evidence["projectCompletedWhileContextFreeHeld"] = true;
	});

	it("keeps one owner across projects, workspace moves, resets and relay replacement", async () => {
		const fixture = ProcessHarness.create();
		harness = fixture;
		writeFileSync(join(fixture.root, "daemon-session-workspace-proof"), "");
		const projectB = join(fixture.root, "project-b");
		const worktreeA = join(fixture.root, "worktree-a");
		const worktreeB = join(fixture.root, "worktree-b");
		const gitEnv = { ...process.env };
		for (const key of [
			"GIT_DIR",
			"GIT_INDEX_FILE",
			"GIT_WORK_TREE",
			"GIT_COMMON_DIR",
		])
			delete gitEnv[key];
		for (const [project, worktree] of [
			[fixture.projectDir, worktreeA],
			[projectB, worktreeB],
		] as const) {
			mkdirSync(project, { recursive: true });
			for (const args of [
				["init", "-b", "main", project],
				[
					"-C",
					project,
					"-c",
					"user.name=Workspace test",
					"-c",
					"user.email=workspace@example.test",
					"-c",
					"core.hooksPath=/dev/null",
					"commit",
					"--allow-empty",
					"-m",
					"Fixture",
				],
				["-C", project, "worktree", "add", "-b", "workspace", worktree],
			])
				execFileSync("git", args, { env: gitEnv, stdio: "pipe" });
		}
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					{
						path: fixture.projectDir,
						folders: [fixture.projectDir],
						slug: "process-test",
						addedAt: 1,
					},
					{
						path: projectB,
						folders: [projectB],
						slug: "project-b",
						addedAt: 2,
					},
				],
			} satisfies DaemonConfig),
		);
		await fixture.restart();
		const a = await fixture.connect();
		const sessionA = await a.createSession("Project A");
		await a.preWarmSession(sessionA);
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionB = await b.createSession("Project B");
		await b.preWarmSession(sessionB);
		await b.preWarmDraft("project-b-worktree", { worktreePath: worktreeB });
		evidence = { sessionA, sessionB };
		const last = (sessionId: string) =>
			observations()
				.filter((call) => call.sessionId === sessionId)
				.at(-1);
		expect(last(sessionA)).toEqual({
			sessionId: sessionA,
			owner: 1,
			directory: realpathSync(fixture.projectDir),
			requestedPath: realpathSync(fixture.projectDir),
		});
		expect(last(sessionB)).toEqual({
			sessionId: sessionB,
			owner: 1,
			directory: realpathSync(projectB),
			requestedPath: realpathSync(projectB),
		});
		await fixture.requestRpc({
			_tag: "MoveSessionWorkspace",
			sessionId: sessionA,
			path: worktreeA,
		});
		await a.preWarmSession(sessionA);
		await b.preWarmSession(sessionB);
		expect(last(sessionA)?.directory).toBe(realpathSync(worktreeA));
		expect(last(sessionA)?.requestedPath).toBe(realpathSync(worktreeA));
		expect(last(sessionB)?.directory).toBe(realpathSync(projectB));
		expect(last(sessionB)?.requestedPath).toBe(realpathSync(projectB));
		await fixture.requestRpc({
			_tag: "MoveSessionWorkspace",
			sessionId: sessionB,
			path: worktreeB,
		});
		await b.preWarmSession(sessionB);
		expect(last(sessionB)?.directory).toBe(realpathSync(worktreeB));
		await fixture.requestRpc({
			_tag: "MoveSessionWorkspace",
			sessionId: sessionA,
			path: fixture.projectDir,
		});
		await a.preWarmSession(sessionA);
		await b.preWarmSession(sessionB);
		expect(last(sessionA)?.directory).toBe(realpathSync(fixture.projectDir));
		expect(last(sessionB)?.directory).toBe(realpathSync(worktreeB));
		const extraB = join(fixture.root, "extra-b");
		execFileSync(
			"git",
			["-C", projectB, "worktree", "add", "-b", "secondary", extraB],
			{
				env: gitEnv,
				stdio: "pipe",
			},
		);
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "project-b",
			folders: [projectB, extraB],
		});
		const replacement = await fixture.connect(sessionB, undefined, "project-b");
		await replacement.preWarmSession(sessionB);
		expect(last(sessionB)?.directory).toBe(realpathSync(worktreeB));
		await fixture.requestRpc({
			_tag: "MoveSessionWorkspace",
			sessionId: sessionB,
			path: projectB,
		});
		await replacement.preWarmSession(sessionB);
		expect(last(sessionB)?.directory).toBe(realpathSync(projectB));
		expect(last(sessionB)?.requestedPath).toBe(realpathSync(projectB));
		const secondaryB = await replacement.createSession(
			"Project B secondary folder",
			undefined,
			"claude",
			{ worktreePath: extraB },
		);
		await replacement.preWarmSession(secondaryB);
		evidence["secondaryB"] = secondaryB;
		expect(last(secondaryB)?.directory).toBe(realpathSync(extraB));
		await a.preWarmSession(sessionA);
		expect(last(sessionA)?.directory).toBe(realpathSync(fixture.projectDir));
		expect(new Set(observations().map(({ owner }) => owner))).toEqual(
			new Set([1]),
		);
	}, 60_000);
});
