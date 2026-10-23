// Failure modes: relative account logins follow a runner or scratch cwd, ~ is
// treated literally, updates bypass normalization, or clearing a folder loses
// the captured launch login. Discovery and both query paths must agree.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

let harness: ProcessHarness | undefined;
const checks: Record<string, unknown>[] = [];

afterEach(async ({ task }) => {
	if (!harness) return;
	const fixture = harness;
	try {
		await fixture.dispose();
		expect(fixture.remainingRunnerPids()).toEqual([]);
	} finally {
		writeFileSync(
			"/tmp/82tn9-8-round1-account-folders.json",
			`${JSON.stringify(
				{
					bead: "conduit-test-82tn.9.8",
					result: task.result?.state,
					failures: task.result?.errors?.map(({ message }) => message),
					base: fixture.projectDir,
					checks,
					remainingRunnerPids: fixture.remainingRunnerPids(),
				},
				null,
				2,
			)}\n`,
		);
		harness = undefined;
	}
});

it("uses one admitted account folder for discovery, pre-warm, sends and scratch title generation across projects", async () => {
	harness = ProcessHarness.create({ shellEnvProof: true });
	const fixture = harness;
	const projectB = join(fixture.root, "project-b");
	mkdirSync(projectB, { recursive: true });
	const configPath = join(fixture.configDir, "daemon.json");
	const config = JSON.parse(readFileSync(configPath, "utf8")) as DaemonConfig;
	const claude = {
		id: "folder-test",
		name: "Folder test",
		driver: "claude" as const,
		managed: false,
		port: 0,
		configDir: ".claude-custom",
	};
	writeFileSync(
		configPath,
		JSON.stringify({
			...config,
			instances: [...(config.instances ?? []), claude],
			projects: [
				...config.projects,
				{
					path: projectB,
					folders: [projectB],
					slug: "project-b",
					addedAt: 2,
				},
			],
		} satisfies DaemonConfig),
	);
	await fixture.restart({
		startupTimeoutMs: 90_000,
		runnerStartupTimeoutMs: 90_000,
	});
	const browser = await fixture.connect(undefined, undefined, "project-b");
	for (const [name, configured, expected] of [
		[
			"relative-loaded",
			".claude-custom",
			join(fixture.projectDir, ".claude-custom"),
		],
		[
			"absolute-added",
			join(fixture.root, "absolute-login"),
			join(fixture.root, "absolute-login"),
		],
		[
			"home-updated",
			"~/.claude-custom",
			join(fixture.root, "home/.claude-custom"),
		],
		["home-only", "~", join(fixture.root, "home")],
		["no-folder", "", join(fixture.root, "claude")],
	] as const) {
		let accountId = claude.id;
		if (name === "absolute-added") {
			const added = await fixture.requestRpc({
				_tag: "AddInstance",
				driver: "claude",
				name,
				configDir: configured,
			});
			if (!added.addedInstanceId) throw new Error("Missing added account");
			accountId = added.addedInstanceId;
		} else if (name !== "relative-loaded") {
			await fixture.requestRpc({
				_tag: "UpdateInstance",
				instanceId: accountId,
				configDir: configured,
			});
		}
		mkdirSync(join(expected, "commands"), { recursive: true });
		writeFileSync(
			join(expected, "commands", `${name}.md`),
			"Describe the login folder.\n",
		);
		// Title generation selects the default account independently of the session.
		await fixture.requestRpc({ _tag: "SetDefault", instanceId: accountId });
		const sessionId = await browser.createSession(undefined, accountId);
		const prompt = `ACCOUNT_FOLDER_${name}`;
		await browser.preWarmSession(sessionId, 60_000);
		await browser.send(sessionId, prompt, 60_000);
		await vi.waitFor(() =>
			expect(
				fixture
					.claudeTitles()
					.some(({ prompt: title }) => title.includes(prompt)),
			).toBe(true),
		);
		const titles = readFileSync(
			join(fixture.root, "claude-titles.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						prompt: string;
						cwd: string;
						configDir?: string;
					},
			);
		const title = titles.find(({ prompt: text }) => text.includes(prompt));
		checks.push({ name, configured, expected, title });
		expect(title?.cwd).toContain(
			join(fixture.configDir, "text-generation/run-"),
		);
		expect(title?.configDir).toBe(expected);
		const query = fixture.marks.find(
			(mark) => mark.kind === "query" && mark.runnerSessionId === sessionId,
		);
		if (query?.kind !== "query") throw new Error("Missing pre-warm query");
		expect(query.env["CLAUDE_CONFIG_DIR"]).toBe(expected);
		expect(query.env["CONDUIT_ENV_PROOF"]).toBe("server-cache");
		expect(
			fixture.marks.filter(
				(mark) => mark.kind === "query" && mark.runnerSessionId === sessionId,
			),
		).toHaveLength(1);
		const commands = await fixture.requestRpc({
			_tag: "GetCommands",
			projectSlug: "project-b",
			instanceId: accountId,
		});
		expect(commands.commands).toEqual(
			expect.arrayContaining([expect.objectContaining({ name })]),
		);
		const account = (
			await fixture.requestRpc({ _tag: "GetInstances" })
		).instances.find(({ id }) => id === accountId);
		expect(account?.configDir).toBe(configured || undefined);
		checks[checks.length - 1] = {
			name,
			configured,
			expected,
			title,
			queryConfigDir: query.env["CLAUDE_CONFIG_DIR"],
			shellMarker: query.env["CONDUIT_ENV_PROOF"],
			discoveryCommand: name,
		};
	}
}, 180_000);
