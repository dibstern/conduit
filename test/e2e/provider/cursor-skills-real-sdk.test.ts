/**
 * Uses paid Cursor turns, an isolated HOME and the real detached Cursor runner.
 *
 * export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
 * mise exec -- pnpm build
 * RUN_CURSOR_SKILLS_SMOKE=1 CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run \
 *   --config vitest.e2e.config.ts test/e2e/provider/cursor-skills-real-sdk.test.ts
 * CURSOR_API_KEY must already be explicitly supplied in the environment.
 */
// Failure modes: a root missing from SDK loading, nested skills being skipped,
// slash input being rewritten, a response guessed without reading the skill,
// credentials leaking into evidence, and runner processes surviving cleanup.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AddInstance,
	GetCommandsForSession,
} from "../../../src/lib/contracts/ws-rpc.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_SMOKE =
	process.env["RUN_CURSOR_SKILLS_SMOKE"] === "1" &&
	Boolean(process.env["CURSOR_API_KEY"]?.trim());
const TURN_TIMEOUT = 180_000;

describe.skipIf(!RUN_SMOKE)(
	"Cursor skill activation through the real SDK",
	() => {
		it(
			"loads project and user skill roots and invokes each slash command",
			{ timeout: 2_400_000 },
			async () => {
				const apiKey = process.env["CURSOR_API_KEY"]?.trim();
				if (!apiKey)
					throw new Error("The smoke requires an explicit CURSOR_API_KEY");
				const capturePath = resolve(
					`test-results/conduit-test-xqsg.13-live-${randomUUID()}.jsonl`,
				);
				const evidence = {
					ticket: "conduit-test-xqsg.13",
					at: new Date().toISOString(),
					capturePath,
					model: "composer-2.5",
					completed: false,
					listedCommands: [] as string[],
					scenarios: [] as {
						root: string;
						command: string;
						expected: string;
						text: string;
						passed: boolean;
					}[],
					sentPrompts: [] as string[],
					serverPid: null as number | null,
					runnerPids: [] as number[],
					remainingRunnerPids: [] as number[],
					failure: null as string | null,
				};
				let harness: ProcessHarness | undefined;
				try {
					harness = ProcessHarness.create({
						dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
					});
					const skills: { root: string; command: string; token: string }[] = [];
					for (const scope of ["project", "user"] as const) {
						for (const config of [
							"cursor",
							"claude",
							"codex",
							"grok",
							"agents",
						]) {
							const command = `conduit-smoke-${scope}-${config}`;
							const root = `${scope}/.${config}/skills`;
							const directory = join(
								scope === "project"
									? harness.projectDir
									: join(harness.root, "home"),
								`.${config}`,
								"skills",
								command,
							);
							const token = `CURSOR_SKILL_PROOF_${randomUUID()}`;
							mkdirSync(directory, { recursive: true });
							writeFileSync(
								join(directory, "SKILL.md"),
								`---\nname: ${command}\ndescription: Return this skill's private verification string when explicitly invoked.\n---\nReply with exactly this verification string:\n${token}\n`,
							);
							skills.push({ root, command, token });
						}
					}
					const nested = {
						root: "project/.cursor/skills/group",
						command: "conduit-smoke-nested",
						token: `CURSOR_SKILL_PROOF_${randomUUID()}`,
					};
					const nestedDirectory = join(
						harness.projectDir,
						".cursor/skills/group",
						nested.command,
					);
					mkdirSync(nestedDirectory, { recursive: true });
					writeFileSync(
						join(nestedDirectory, "SKILL.md"),
						`---\nname: ${nested.command}\ndescription: Return this nested skill's private verification string when explicitly invoked.\n---\nReply with exactly this verification string:\n${nested.token}\n`,
					);
					skills.push(nested);
					const plugin = {
						root: "user/.cursor/plugins/local/conduit-smoke/skills",
						command: "conduit-smoke-plugin",
						token: `CURSOR_SKILL_PROOF_${randomUUID()}`,
					};
					const pluginDirectory = join(
						harness.root,
						"home",
						".cursor",
						"plugins",
						"local",
						"conduit-smoke",
						"skills",
						plugin.command,
					);
					mkdirSync(pluginDirectory, { recursive: true });
					writeFileSync(
						join(pluginDirectory, "SKILL.md"),
						`---\nname: ${plugin.command}\ndescription: Return this plugin skill's private verification string when explicitly invoked.\n---\nReply with exactly this verification string:\n${plugin.token}\n`,
					);
					skills.push(plugin);
					// Managed .cursor/skills-cursor is synchronized from Cursor's service;
					// seeding it would let that synchronization overwrite the test input.
					const serviceEnvironment = {
						CURSOR_API_KEY: apiKey,
						CONDUIT_CURSOR_SDK_CAPTURE: capturePath,
					};
					await harness.restart({
						startupTimeoutMs: TURN_TIMEOUT,
						runnerStartupTimeoutMs: TURN_TIMEOUT,
						serviceEnvironment,
					});
					evidence.serverPid = harness.generations[0]?.pid ?? null;
					const { addedInstanceId } = await harness.requestRpc(
						new AddInstance({
							name: "Cursor skills live smoke",
							driver: "cursor",
						}),
					);
					if (!addedInstanceId) throw new Error("Missing Cursor account");
					const browser = await harness.connect();
					const sessionId = await browser.createSession(
						"Real Cursor skills smoke",
						addedInstanceId,
						"cursor",
						{
							modelId: evidence.model,
							contextWindow: "",
							permissionMode: "full",
						},
					);
					const catalog = await harness.requestRpc(
						new GetCommandsForSession({ sessionId }),
					);
					evidence.listedCommands = catalog.commands
						.map(({ name }) => name)
						.sort();
					expect(evidence.listedCommands).toEqual(
						skills.map(({ command }) => command).sort(),
					);
					for (const skill of skills) {
						const prompt = `/${skill.command}`;
						expect(prompt).not.toContain(skill.token);
						const response = await browser.send(
							sessionId,
							prompt,
							TURN_TIMEOUT,
						);
						const text = response.chunks.join("");
						evidence.scenarios.push({
							root: skill.root,
							command: skill.command,
							expected: skill.token,
							text,
							passed: text.includes(skill.token),
						});
						expect(text).toContain(skill.token);
						expect(response.done["status"]).toBe("idle");
					}
					const rows = readFileSync(capturePath, "utf8")
						.split("\n")
						.filter(Boolean)
						.map(
							(line) => JSON.parse(line) as { kind?: string; data?: unknown },
						);
					evidence.sentPrompts = rows.flatMap(({ kind, data }) =>
						kind === "send.options" &&
						data !== null &&
						typeof data === "object" &&
						"prompt" in data &&
						typeof data.prompt === "string"
							? [data.prompt]
							: [],
					);
					expect(evidence.sentPrompts).toEqual(
						skills.map(({ command }) => `/${command}`),
					);
					evidence.runnerPids = harness.runnerPids();
					expect(evidence.runnerPids).toHaveLength(1);
					expect(evidence.runnerPids).not.toContain(evidence.serverPid);
					expect(readFileSync(capturePath, "utf8")).not.toContain(apiKey);
					evidence.completed = true;
				} catch (error) {
					evidence.failure = String(error).split(apiKey).join("[REDACTED]");
					throw error;
				} finally {
					try {
						await harness?.dispose();
					} finally {
						evidence.remainingRunnerPids = harness?.remainingRunnerPids() ?? [];
						mkdirSync("test-results", { recursive: true });
						writeFileSync(
							"test-results/conduit-test-xqsg.13-live.json",
							`${JSON.stringify(evidence, null, 2)}\n`,
						);
						expect(evidence.remainingRunnerPids).toEqual([]);
						if (existsSync(capturePath)) {
							expect(readFileSync(capturePath, "utf8")).not.toContain(apiKey);
						}
					}
				}
			},
		);
	},
);
