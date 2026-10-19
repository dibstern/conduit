// Failure cases: wrong account/workspace, missing compatibility roots, excessive
// nesting/counts, external symlink traversal, invalid YAML and altered prompts.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 90_000;
const ROOTS = [".cursor", ".claude", ".codex", ".grok", ".agents"];

function skill(directory: string, frontmatter = "description: Test skill") {
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\n${frontmatter}\n---\nUse this skill.\n`,
	);
}

function trace(path: string): { kind?: string; data?: unknown }[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("Cursor skills through the built daemon and runner", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			const proof = fixture.proof();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/conduit-test-xqsg.13.json",
				`${JSON.stringify(
					{
						ticket: "conduit-test-xqsg.13",
						...evidence,
						result: task.result?.state,
						errors: task.result?.errors?.map(({ message }) => message) ?? [],
						buildIdentity: proof.buildIdentity,
						daemonPids: proof.generations.map(({ pid }) => pid),
						runnerPids: fixture.runnerPids(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
						rpcDecodeFailures: proof.rpcDecodeFailures,
						...(task.result?.errors?.length ? { logTail: proof.logTail } : {}),
					},
					null,
					2,
				).replaceAll(fixture.root, "<root>")}\n`,
			);
			harness = undefined;
		}
	}, TIMEOUT);

	it("lists bounded nested and linked skills, sends /skill, and refreshes with the workspace", async () => {
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
		});
		const fixture = harness;
		const home = join(fixture.root, "home");
		execFileSync("git", ["init", "-b", "main", fixture.root], {
			stdio: "pipe",
		});
		expect(existsSync(join(fixture.projectDir, ".git"))).toBe(false);
		const expected = [
			"linked",
			"nested",
			"manual",
			"folded",
			"crlf",
			"sdk-only",
			"managed",
			"package-skill",
			"openai-docs",
			"plugin-root",
			"plugin-review",
			"plugin-explicit",
			"plugin-manual",
			"plugin-grouped",
			"plugin-fallback",
		];
		for (const [scope, directory] of [
			["project", fixture.projectDir],
			["user", home],
		] as const) {
			for (const root of ROOTS) {
				const name = `${scope}-${root.slice(1)}`;
				skill(join(directory, root, "skills", name));
				expected.push(name);
			}
		}
		const root = join(fixture.projectDir, ".cursor", "skills");
		const plugins = join(home, ".cursor", "plugins", "local");
		const standardPlugin = join(plugins, "standard");
		skill(standardPlugin, "name: plugin-root\ndescription: Root plugin skill");
		const fallbackPluginSkill = join(
			standardPlugin,
			"skills",
			"plugin-fallback",
		);
		mkdirSync(fallbackPluginSkill, { recursive: true });
		writeFileSync(
			join(fallbackPluginSkill, "SKILL.md"),
			"Plugin skill without frontmatter.\n",
		);
		skill(
			join(standardPlugin, "skills", "review"),
			"name: plugin-review\nmetadata:\n  surfaces: ide",
		);
		skill(join(standardPlugin, "skills", "group", "not-a-direct-child"));
		skill(join(standardPlugin, "skills", "automatic"), "alwaysApply: true");
		const explicitPlugin = join(plugins, "explicit");
		mkdirSync(join(explicitPlugin, ".cursor-plugin"), { recursive: true });
		writeFileSync(
			join(explicitPlugin, ".cursor-plugin", "plugin.json"),
			JSON.stringify({
				name: "explicit",
				skills: [
					"custom/review/SKILL.md",
					"custom/manual",
					"../outside-plugin",
				],
			}),
		);
		skill(
			join(explicitPlugin, "custom", "review"),
			"name: plugin-explicit\ndescription: Explicit plugin document",
		);
		skill(join(explicitPlugin, "custom", "manual"), "name: plugin-manual");
		skill(join(explicitPlugin, "skills", "must-not-use-default"));
		const groupedPlugin = join(plugins, "grouped");
		mkdirSync(groupedPlugin, { recursive: true });
		writeFileSync(
			join(groupedPlugin, "plugin.json"),
			JSON.stringify({ name: "grouped", skills: "custom" }),
		);
		skill(
			join(groupedPlugin, "custom", "one"),
			"name: plugin-grouped\ndescription: Grouped plugin skill",
		);
		skill(
			join(groupedPlugin, "custom"),
			"name: must-not-list-string-root\ndescription: Not a child skill",
		);
		skill(join(groupedPlugin, "skills", "must-not-use-conventional"));
		const externalPlugin = join(fixture.root, "external-plugin");
		skill(join(externalPlugin, "skills", "must-not-list-external-plugin"));
		symlinkSync(externalPlugin, join(plugins, "external"), "dir");
		symlinkSync(
			externalPlugin,
			join(standardPlugin, "skills", "external"),
			"dir",
		);
		for (const reserved of [
			"imagegen",
			"openai-docs",
			"opneai-docs",
			"plugin-creator",
			"skill-creator",
			"skill-installer",
		])
			skill(join(fixture.projectDir, ".codex", "skills", reserved));
		skill(join(root, "openai-docs"));
		skill(join(home, ".cursor", "skills-cursor", "managed"));
		skill(
			join(
				fixture.projectDir,
				"packages",
				"example",
				".agents",
				"skills",
				"package-skill",
			),
		);
		skill(
			join(root, "group", "nested"),
			"name: wrong-name\ndescription: Nested skill",
		);
		skill(join(root, "manual"), "disable-model-invocation: true");
		skill(
			join(root, "folded"),
			"description: >-\n  Ship a release\n  with checks",
		);
		skill(join(root, "crlf"));
		const crlf = join(root, "crlf", "SKILL.md");
		writeFileSync(crlf, readFileSync(crlf, "utf8").replaceAll("\n", "\r\n"));
		skill(
			join(root, "sdk-only"),
			"description: SDK skill\nmetadata:\n  surfaces: [sdk]",
		);
		for (const [name, metadata] of [
			["invalid", "description: [unterminated"],
			["missing-description", "name: missing-description"],
			["automatic", "description: Always applied\nalwaysApply: true"],
			["ide-only", "description: IDE skill\nmetadata:\n  surfaces: ide, cli"],
		] as const)
			skill(join(root, name), metadata);
		for (const skipped of [
			".hidden",
			"node_modules",
			"dist",
			"build",
			"__pycache__",
		])
			skill(join(root, skipped, "ignored"));
		skill(
			join(
				root,
				...Array.from({ length: 11 }, (_, i) => `depth-${i}`),
				"too-deep",
			),
		);
		const outside = join(fixture.root, "external", "linked");
		skill(outside);
		skill(join(outside, "must-not-walk"));
		symlinkSync(outside, join(root, "linked"), "dir");
		symlinkSync(root, join(root, "cycle"), "dir");
		symlinkSync(join(fixture.root, "missing"), join(root, "broken"), "dir");
		const replay = join(fixture.root, "replay.jsonl");
		const capture = join(fixture.root, "capture.jsonl");
		const rows = trace(resolve("test/fixtures/cursor-sdk-traces/basic.jsonl"));
		rows.splice(1, 0, {
			kind: "credential.store",
			data: {
				apiKey: "[REDACTED]",
				backendUrl: "https://api2.cursor.sh",
				createdAtMs: 0,
			},
		});
		writeFileSync(
			replay,
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		);
		await fixture.restart({
			startupTimeoutMs: TIMEOUT,
			runnerStartupTimeoutMs: TIMEOUT,
			serviceEnvironment: {
				CONDUIT_CURSOR_SDK_TRACE: replay,
				CONDUIT_CURSOR_SDK_CAPTURE: capture,
			},
		});
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			name: "Cursor skills",
			driver: "cursor",
		});
		if (!addedInstanceId) throw new Error("Missing Cursor account");
		const draft = await fixture.requestRpc({
			_tag: "GetCommands",
			projectSlug: "process-test",
			instanceId: addedInstanceId,
		});
		evidence = { sourceCapture: "basic.jsonl", draft: draft.commands };
		expect(draft.commands.map(({ name }) => name).sort()).toEqual(
			expected.sort(),
		);
		expect(
			draft.commands.find(({ name }) => name === "folded")?.description,
		).toBe("Ship a release with checks");
		expect(draft.commands.some(({ builtin }) => builtin)).toBe(false);
		const browser = await fixture.connect();
		const sessionId = await browser.createSession(
			"Cursor skills",
			addedInstanceId,
			"cursor",
			{
				modelId: "composer-2.5",
				contextWindow: "",
				permissionMode: "full",
			},
		);
		const before = await fixture.requestRpc({ _tag: "GetCommands", sessionId });
		expect(before.commands).toEqual(draft.commands);
		const sent = await browser.send(sessionId, "/nested release", TIMEOUT);
		expect(sent.chunks.join("")).toBe(
			"Hi David — good to meet you. What would you like to work on today?",
		);
		const sends = trace(capture).filter(({ kind }) => kind === "send.options");
		expect(sends.at(-1)?.data).toMatchObject({ prompt: "/nested release" });
		evidence["sent"] = sends.at(-1)?.data;
		skill(join(root, "fresh"));
		rmSync(join(root, "crlf"), { recursive: true });
		await fixture.requestRpc({
			_tag: "ReloadProviderSession",
			sessionId,
			commandId: randomUUID(),
		});
		const refreshed = await fixture.requestRpc({
			_tag: "GetCommands",
			sessionId,
		});
		expect(refreshed.commands.map(({ name }) => name).sort()).toEqual(
			expected
				.filter((name) => name !== "crlf")
				.concat("fresh")
				.sort(),
		);
		evidence["refreshed"] = refreshed.commands;
		const moved = join(fixture.root, "moved-workspace");
		mkdirSync(moved);
		execFileSync("git", ["init", "-b", "main", moved], { stdio: "pipe" });
		skill(join(moved, ".agents", "skills", "moved-only"));
		await fixture.requestRpc({
			_tag: "SaveProject",
			slug: "process-test",
			folders: [moved],
		});
		const afterMove = await fixture.requestRpc({
			_tag: "GetCommands",
			sessionId,
		});
		expect(afterMove.commands.map(({ name }) => name).sort()).toEqual(
			expected
				.filter(
					(name) =>
						name.startsWith("user-") ||
						name.startsWith("plugin-") ||
						name === "managed",
				)
				.concat("moved-only")
				.sort(),
		);
		expect(
			(
				await fixture.requestRpc({
					_tag: "GetCommands",
					projectSlug: "process-test",
					instanceId: addedInstanceId,
				})
			).commands,
		).toEqual(afterMove.commands);
		evidence["afterMove"] = afterMove.commands;
		for (let i = 0; i < 300; i++)
			skill(join(moved, ".cursor", "skills", `bounded-${i}`));
		const bounded = await fixture.requestRpc({
			_tag: "GetCommands",
			sessionId,
		});
		expect(bounded.commands).toHaveLength(256);
		expect(new Set(bounded.commands.map(({ name }) => name)).size).toBe(256);
		evidence["boundedCount"] = bounded.commands.length;
		expect(fixture.proof().rpcDecodeFailures).toEqual([]);
	}, 240_000);
});
