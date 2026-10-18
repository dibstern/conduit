import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import type { ProcessMark } from "../../helpers/fake-claude-process-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const gitVariables = [
	"GIT_DIR",
	"GIT_INDEX_FILE",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
] as const;
const gitEnv = { ...process.env };
for (const key of gitVariables) delete gitEnv[key];

function git(directory: string, ...args: string[]) {
	return execFileSync("git", ["-C", directory, ...args], {
		env: gitEnv,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function seedClaudeFiles(directory: string, label: "main" | "worktree") {
	const claude = join(directory, ".claude");
	mkdirSync(join(claude, "commands"), { recursive: true });
	writeFileSync(
		join(claude, "settings.json"),
		JSON.stringify({ alwaysThinkingEnabled: label === "worktree" }),
	);
	writeFileSync(
		join(claude, "commands", "directory-command.md"),
		`---\ndescription: ${label} command\n---\nUse the ${label} command.\n`,
	);
	for (const name of [
		"release-notes",
		label === "main" ? "main-only" : "changelog-style",
	]) {
		const skill = join(claude, "skills", name);
		mkdirSync(skill, { recursive: true });
		writeFileSync(
			join(skill, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${label} ${name}\n---\nUse the ${label} skill instructions.\n`,
		);
	}
}

function providerQuery(harness: ProcessHarness, sessionId: string) {
	const pids = new Set(
		harness.marks.flatMap((mark) =>
			mark.kind === "runner-started" && mark.sessionId === sessionId
				? [mark.pid]
				: [],
		),
	);
	// Runners report SDK calls in the proof file; lifecycle marks arrive over
	// daemon IPC. Join them by the runner PID, as the workspace harness does.
	const marks = readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line): ProcessMark => JSON.parse(line));
	const query = marks
		.filter((mark) => mark.kind === "query" && pids.has(mark.pid))
		.at(-1);
	if (query?.kind !== "query")
		throw new Error("Session query was not recorded");
	const options = JSON.parse(query.optionsJson) as { cwd: string };
	const settings = JSON.parse(query.effectiveSettingsJson) as {
		alwaysThinkingEnabled: boolean;
	};
	return {
		cwd: options.cwd,
		alwaysThinkingEnabled: settings.alwaysThinkingEnabled,
	};
}

describe("Session directory discovery through the built daemon", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	async function start(name: string) {
		for (const key of gitVariables) vi.stubEnv(key, undefined);
		scenario = name;
		evidence = {};
		harness = ProcessHarness.create({
			restartProof: true,
			claudeReplay: { turns: ["skill-loads-turn"] },
		});
		git(harness.projectDir, "init", "-b", "main");
		git(
			harness.projectDir,
			"-c",
			"user.name=Directory test",
			"-c",
			"user.email=directory@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--allow-empty",
			"-m",
			"Initial commit",
		);
		const linked = join(harness.root, "linked-worktree");
		git(
			harness.projectDir,
			"worktree",
			"add",
			"-b",
			"feature/directory",
			linked,
		);
		const worktree = realpathSync(linked);
		seedClaudeFiles(harness.projectDir, "main");
		seedClaudeFiles(worktree, "worktree");
		await harness.restart({
			startupTimeoutMs: 60_000,
			runnerStartupTimeoutMs: 30_000,
		});
		return {
			fixture: harness,
			worktree,
			socket: join(harness.configDir, "relay.sock"),
		};
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		evidence["result"] = task.result?.state;
		evidence["errors"] =
			task.result?.errors?.map(({ message }) => message).sort() ?? [];
		try {
			await fixture.dispose();
			evidence["remainingRunnerPids"] = fixture.remainingRunnerPids();
			expect(evidence["remainingRunnerPids"]).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			// Stable keys, named sessions and no timestamps/PIDs make successful
			// runs byte-for-byte repeatable. Normalize paths in keys and values.
			const normalized = JSON.stringify(
				evidence,
				(_key, value: unknown) =>
					value !== null && typeof value === "object" && !Array.isArray(value)
						? Object.fromEntries(
								Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
							)
						: value,
				2,
			).replaceAll(fixture.root, "<root>");
			writeFileSync(`test-results/82tn-8-${scenario}.json`, `${normalized}\n`);
			harness = undefined;
			vi.unstubAllEnvs();
		}
	});

	it("discovers, reads and uses a moved session's skills and settings without changing other views", async () => {
		const { fixture, worktree, socket } = await start("discovery");
		const browser = await fixture.connect();
		const unmoved = await browser.createSession("Unmoved directory");
		const moved = await browser.createSession("Moved directory");
		// Warm in main before moving, so cached provider state must also follow.
		await browser.preWarmSession(moved, 45_000);
		expect(providerQuery(fixture, moved)).toEqual({
			cwd: fixture.projectDir,
			alwaysThinkingEnabled: false,
		});

		async function readView(sessionId?: string) {
			const { commands } = await sendRpcRequest(
				socket,
				sessionId
					? { _tag: "GetCommands", sessionId }
					: { _tag: "GetCommands", projectSlug: "process-test" },
			);
			const { resolved } = await sendRpcRequest(
				socket,
				sessionId
					? { _tag: "ResolveClaudeSettings", sessionId, instanceId: "claude" }
					: {
							_tag: "ResolveClaudeSettings",
							projectSlug: "process-test",
							instanceId: "claude",
						},
			);
			const skill = await sendRpcRequest(
				socket,
				sessionId
					? { _tag: "GetSkillContent", sessionId, name: "release-notes" }
					: {
							_tag: "GetSkillContent",
							projectSlug: "process-test",
							name: "release-notes",
						},
			);
			return {
				commands: [...commands].sort((a, b) => a.name.localeCompare(b.name)),
				setting: resolved.alwaysThinkingEnabled,
				skill: { path: skill.path, content: skill.content },
			};
		}
		const beforeMove = await readView(moved);
		expect(beforeMove.commands).toContainEqual({
			name: "main-only",
			description: "main main-only",
		});
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: moved,
			path: worktree,
		});
		const views = {
			moved: await readView(moved),
			unmoved: await readView(unmoved),
			sessionless: await readView(),
		};
		evidence["views"] = views;
		for (const [name, directory, thinking] of [
			["moved", worktree, true],
			["unmoved", fixture.projectDir, false],
			["sessionless", fixture.projectDir, false],
		] as const) {
			const view = views[name];
			const label = thinking ? "worktree" : "main";
			expect(view.commands).toContainEqual({
				name: "directory-command",
				description: `${label} command`,
			});
			expect(view.commands).toContainEqual({
				name: "release-notes",
				description: `${label} release-notes`,
			});
			expect(view.commands.some(({ name }) => name === "changelog-style")).toBe(
				thinking,
			);
			expect(view.commands.some(({ name }) => name === "main-only")).toBe(
				!thinking,
			);
			expect(view.setting).toEqual({
				value: thinking,
				source: "project",
				path: join(directory, ".claude", "settings.json"),
			});
			expect(view.skill.path).toBe(
				join(directory, ".claude", "skills", "release-notes", "SKILL.md"),
			);
			expect(view.skill.content).toContain(
				`Use the ${label} skill instructions.`,
			);
		}
		const unmovedContext = { sessionId: unmoved };
		const movedContext = { sessionId: moved };
		await expect(
			sendRpcRequest(socket, {
				_tag: "GetSkillContent",
				...unmovedContext,
				name: "changelog-style",
			}),
		).rejects.toMatchObject({ _tag: "WsRpcError" });
		await expect(
			sendRpcRequest(socket, {
				_tag: "GetSkillContent",
				...movedContext,
				name: "main-only",
			}),
		).rejects.toMatchObject({ _tag: "WsRpcError" });

		await browser.preWarmSession(moved, 45_000);
		const reply = await browser.send(
			moved,
			"/release-notes /changelog-style /main-only",
		);
		expect(reply.chunks.join("")).toContain("notes ready");
		const used = providerQuery(fixture, moved);
		evidence["provider"] = used;
		expect(used).toEqual({ cwd: worktree, alwaysThinkingEnabled: true });
		const { loads } = await sendRpcRequest(socket, {
			_tag: "GetSessionSkills",
			sessionId: moved,
		});
		evidence["loads"] = loads
			.map(({ name, invokedBy, turnOrdinal, running }) => ({
				name,
				invokedBy,
				turnOrdinal,
				running,
			}))
			.sort(
				(a, b) =>
					a.name.localeCompare(b.name) ||
					a.invokedBy.localeCompare(b.invokedBy),
			);
		expect(
			loads
				.filter(({ invokedBy }) => invokedBy === "user")
				.map(({ name }) => name)
				.sort(),
		).toEqual(["changelog-style", "release-notes"]);
		expect(loads).toContainEqual(
			expect.objectContaining({
				name: "changelog-style",
				invokedBy: "agent",
				running: false,
			}),
		);

		// Resolve at each use, including a move back without a daemon restart.
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: moved,
			path: fixture.projectDir,
		});
		const returned = await readView(moved);
		evidence["returned"] = returned;
		expect(returned).toEqual(views.unmoved);
		const missingContext = {
			sessionId: "missing-session",
		};
		for (const request of [
			{ _tag: "GetCommands", ...missingContext },
			{ _tag: "GetSkillContent", ...missingContext, name: "release-notes" },
			{
				_tag: "ResolveClaudeSettings",
				...missingContext,
				instanceId: "claude",
			},
		])
			await expect(sendRpcRequest(socket, request)).rejects.toMatchObject({
				_tag: "WsRpcError",
			});
	}, 150_000);

	it("generates titles and starts queries in each session's current directory", async () => {
		const { fixture, worktree, socket } = await start("titles");
		const browser = await fixture.connect();
		const unmoved = await browser.createSession();
		const moved = await browser.createSession();
		await sendRpcRequest(socket, {
			_tag: "MoveSessionWorkspace",
			sessionId: moved,
			path: worktree,
		});
		for (const [label, sessionId, directory, thinking] of [
			["main", unmoved, fixture.projectDir, false],
			["worktree", moved, worktree, true],
		] as const) {
			const prompt = `TITLE_DIRECTORY_82TN_${label}`;
			await browser.preWarmSession(sessionId, 45_000);
			const reply = await browser.send(sessionId, prompt);
			expect(reply.chunks.join("")).toContain("notes ready");
			await vi.waitFor(() => {
				const title = fixture
					.claudeTitles()
					.find(({ prompt: titlePrompt }) => titlePrompt.includes(prompt));
				expect(title?.cwd).toBe(directory);
			});
			const used = providerQuery(fixture, sessionId);
			expect(used).toEqual({ cwd: directory, alwaysThinkingEnabled: thinking });
			evidence[label] = { provider: used, titleDirectory: directory };
		}
	}, 150_000);
});
