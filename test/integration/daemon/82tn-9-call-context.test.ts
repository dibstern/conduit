import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { isRecord } from "../../../src/lib/utils.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

describe("provider call context through the daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "separate";

	afterEach(async () => {
		if (!harness) return;
		const fixture = harness;
		const launches = fixture
			.claudeOptions()
			.map(({ pid, options, prompt, configDir }) => {
				const env = options["env"];
				return {
					pid,
					prompt,
					configDir,
					cwd: options["cwd"],
					extraFolders: options["additionalDirectories"],
					env: Object.fromEntries(
						[
							"PROJECT_OWNER",
							"ACCOUNT_OWNER",
							"CONDUIT_SESSION_ID",
							"CONDUIT_ENV_PROOF",
						].map((key) => [key, isRecord(env) ? env[key] : undefined]),
					),
				};
			});
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const { disposed, runnerCleanup, generations } = fixture.proof();
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				`test-results/process-harness/82tn-9-call-context-${scenario}.json`,
				JSON.stringify(
					{
						launches,
						cleanup: {
							disposed,
							runnerCleanup,
							daemons: generations.map(({ pid, exitCode, signal }) => ({
								pid,
								exitCode,
								signal,
							})),
						},
					},
					null,
					2,
				),
			);
			harness = undefined;
		}
	});

	it.each([
		false,
		true,
	])("keeps concurrent project launches' directory, extra folders, environment and account separate, shared directory %s", async (sharedDirectory) => {
		scenario = sharedDirectory ? "shared" : "separate";
		const fixture = ProcessHarness.create({ shellEnvProof: true });
		harness = fixture;
		const projectB = sharedDirectory
			? fixture.projectDir
			: join(fixture.root, "project-b");
		const extraA = join(fixture.root, "extra-a");
		const extraB = join(fixture.root, "extra-b");
		const accountA = join(fixture.root, "account-a");
		const accountB = join(fixture.root, "account-b");
		for (const directory of [projectB, extraA, extraB, accountA, accountB])
			mkdirSync(directory, { recursive: true });
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
		const first = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Account A",
			driver: "claude",
			configDir: accountA,
			env: { ACCOUNT_OWNER: "account-a" },
		});
		const second = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Account B",
			driver: "claude",
			configDir: accountB,
			env: { ACCOUNT_OWNER: "account-b" },
		});
		if (!first.addedInstanceId || !second.addedInstanceId)
			throw new Error("Missing isolated test accounts");
		const a = await fixture.connect();
		const b = await fixture.connect(undefined, undefined, "project-b");
		const [sessionA, sessionB] = await Promise.all([
			a.createSession("Call A", first.addedInstanceId),
			b.createSession("Call B", second.addedInstanceId),
		]);
		// Sends read the cache immediately; pre-warming waits for its capture.
		await Promise.all([a.preWarmSession(sessionA), b.preWarmSession(sessionB)]);
		await Promise.all([
			a.send(sessionA, "call-context-a"),
			b.send(sessionB, "call-context-b"),
		]);
		const launches = fixture.claudeOptions();
		for (const expected of [
			{
				prompt: "call-context-a",
				cwd: fixture.projectDir,
				extra: extraA,
				account: accountA,
				projectOwner: "project-a",
				accountOwner: "account-a",
				sessionId: sessionA,
			},
			{
				prompt: "call-context-b",
				cwd: projectB,
				extra: extraB,
				account: accountB,
				projectOwner: "project-b",
				accountOwner: "account-b",
				sessionId: sessionB,
			},
		]) {
			const launch = launches.find(({ prompt }) => prompt === expected.prompt);
			expect(launch?.options).toMatchObject({
				cwd: expected.cwd,
				additionalDirectories: [expected.extra],
				env: {
					PROJECT_OWNER: expected.projectOwner,
					ACCOUNT_OWNER: expected.accountOwner,
					CONDUIT_SESSION_ID: expected.sessionId,
					CLAUDE_CONFIG_DIR: expected.account,
					CONDUIT_ENV_PROOF: "server-cache",
				},
			});
			expect(launch?.configDir).toBe(expected.account);
		}
		expect(new Set(launches.map(({ pid }) => pid)).size).toBe(2);
	}, 60_000);
});
