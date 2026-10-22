import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface ContextObservation {
	callerEngine: number;
	resolutionEngine: number;
	sessionId: string;
	projectId: string;
	workspaceRoot: string;
	extraFolders: string[];
	projectOwner: string;
	shellProof: string;
}

// Failures: the daemon engine borrows another project's folders/env;
// it captures stale project settings; a workspace reset uses the wrong root.
describe("daemon project context at provider call time", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	const observations = (): ContextObservation[] => {
		if (!harness) return [];
		const path = join(harness.root, "project-context.ndjson");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as ContextObservation)
			: [];
	};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const calls = observations();
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-10-1-project-context.json",
				JSON.stringify(
					{
						bead: "conduit-test-82tn.10.1",
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						calls,
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

	it("resolves both projects through the daemon engine and sees B's saved folders on its next call", async () => {
		const fixture = ProcessHarness.create({ shellEnvProof: true });
		harness = fixture;
		writeFileSync(join(fixture.root, "project-context-proof"), "");
		const projectB = join(fixture.root, "project-b");
		const extraA = join(fixture.root, "extra-a");
		const extraB = join(fixture.root, "extra-b");
		const replacementB = join(fixture.root, "replacement-b");
		const workspaceB = join(fixture.root, "workspace-b");
		for (const directory of [projectB, extraA, extraB, replacementB])
			mkdirSync(directory, { recursive: true });
		// Git writes are confined to this disposable harness project.
		for (const args of [
			["init", "-b", "main", projectB],
			[
				"-C",
				projectB,
				"-c",
				"user.name=Project context test",
				"-c",
				"user.email=context@example.test",
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"--allow-empty",
				"-m",
				"Fixture",
			],
			["-C", projectB, "worktree", "add", "-b", "context-b", workspaceB],
		])
			execFileSync("git", args, { stdio: "pipe" });
		const configPath = join(fixture.configDir, "daemon.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
		writeFileSync(
			configPath,
			JSON.stringify({
				...config,
				projects: [
					{
						path: fixture.projectDir,
						folders: [fixture.projectDir, extraA],
						slug: "process-test",
						addedAt: 1,
						shellEnv: { overrides: { PROJECT_OWNER: "project-a" } },
					},
					{
						path: projectB,
						folders: [projectB, extraB],
						slug: "project-b",
						addedAt: 2,
						shellEnv: { overrides: { PROJECT_OWNER: "project-b" } },
					},
				],
			} satisfies DaemonConfig),
		);
		await fixture.restart();
		const a = await fixture.connect();
		const sessionA = await a.createSession("Retained engine A");
		await a.preWarmSession(sessionA);
		const anchor = observations().find(
			({ sessionId }) => sessionId === sessionA,
		);
		expect(anchor).toMatchObject({
			callerEngine: 1,
			resolutionEngine: 1,
			projectId: "process-test",
			workspaceRoot: fixture.projectDir,
			extraFolders: [extraA],
			projectOwner: "project-a",
			shellProof: "server-cache",
		});
		const b = await fixture.connect(undefined, undefined, "project-b");
		const sessionB = await b.createSession("Project B through engine A");
		await b.preWarmSession(sessionB);
		const before = observations()
			.filter(({ sessionId }) => sessionId === sessionB)
			.at(-1);
		evidence = { sessionA, sessionB, before };
		expect(before).toMatchObject({
			callerEngine: 1,
			resolutionEngine: 1,
			projectId: "project-b",
			workspaceRoot: projectB,
			extraFolders: [extraB],
			projectOwner: "project-b",
			shellProof: "server-cache",
		});

		const saved = await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "project-b",
			folders: [projectB, replacementB],
		});
		evidence["saved"] = saved;
		expect(saved.savedSlug).toBe("project-b");
		const afterSave = await fixture.connect(sessionB);
		await afterSave.preWarmSession(sessionB);
		const after = observations()
			.filter(({ sessionId }) => sessionId === sessionB)
			.at(-1);
		evidence["after"] = after;
		expect(after).toMatchObject({
			callerEngine: 1,
			resolutionEngine: 1,
			projectId: "project-b",
			workspaceRoot: projectB,
			extraFolders: [replacementB],
			projectOwner: "project-b",
			shellProof: "server-cache",
		});
		await fixture.requestRpc({
			_tag: "MoveSessionWorkspace",
			sessionId: sessionB,
			path: workspaceB,
		});
		await afterSave.preWarmSession(sessionB);
		const afterMove = observations()
			.filter(({ sessionId }) => sessionId === sessionB)
			.at(-1);
		evidence["afterMove"] = afterMove;
		expect(afterMove).toEqual({ ...after, workspaceRoot: workspaceB });
		// A recorded reset must use B's primary folder too; native-directory
		// fallback alone cannot correct a workspace resolved through A.
		await fixture.requestRpc({
			_tag: "MoveSessionWorkspace",
			sessionId: sessionB,
			path: projectB,
		});
		await afterSave.preWarmSession(sessionB);
		const afterReset = observations()
			.filter(({ sessionId }) => sessionId === sessionB)
			.at(-1);
		evidence["afterReset"] = afterReset;
		expect(afterReset).toEqual(after);
		await a.preWarmSession(sessionA);
		expect(
			observations()
				.filter(({ sessionId }) => sessionId === sessionA)
				.at(-1),
		).toEqual(anchor);
	}, 90_000);
});
