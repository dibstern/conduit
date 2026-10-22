// Failure modes: inherited config/plugins/agents/skills or instruction sources,
// lost provider selection, and process/scratch leaks on completion or interruption.
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import {
	availableOpenCodePort,
	isProcessAlive,
	probeOpenCodeHealth,
} from "../../../src/lib/instance/managed-opencode-process.js";
import { openCodeTextServerEffect } from "../../../src/lib/provider/opencode-text-server.js";

const binary = spawnSync("opencode", ["--version"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
	timeout: 15_000,
});
const available = binary.status === 0;
const realBinary = (process.env["PATH"] ?? "")
	.split(delimiter)
	.map((directory) => join(directory, "opencode"))
	.find((candidate) => existsSync(candidate));
const artifact = join(
	process.cwd(),
	"test-results/title-isolation.evidence.json",
);
const roots: string[] = [];

function readWrapperRecords(directory: string) {
	return readdirSync(directory)
		.filter((file) => file.endsWith(".json"))
		.map((file) => {
			const record: unknown = JSON.parse(
				readFileSync(join(directory, file), "utf8"),
			);
			if (
				typeof record !== "object" ||
				record === null ||
				!("wrapperPid" in record) ||
				typeof record.wrapperPid !== "number" ||
				!("childPid" in record) ||
				(record.childPid !== null && typeof record.childPid !== "number") ||
				!("supervisorPid" in record) ||
				typeof record.supervisorPid !== "number" ||
				!("root" in record) ||
				typeof record.root !== "string" ||
				!("environment" in record) ||
				typeof record.environment !== "object" ||
				record.environment === null ||
				!("configEntriesBeforeSpawn" in record) ||
				!Array.isArray(record.configEntriesBeforeSpawn)
			)
				throw new Error("Missing wrapper process evidence");
			return {
				wrapperPid: record.wrapperPid,
				childPid: record.childPid,
				supervisorPid: record.supervisorPid,
				root: record.root,
				configEntriesBeforeSpawn: record.configEntriesBeforeSpawn.filter(
					(entry: unknown): entry is string => typeof entry === "string",
				),
				environment: Object.fromEntries(
					Object.entries(record.environment).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				),
			};
		});
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!available)(
	"OpenCode title server isolation without a model prompt",
	() => {
		it("excludes planted sources and releases its process and scratch on completion and interruption", async () => {
			const root = realpathSync(
				mkdtempSync(join(tmpdir(), "title-isolation-test-")),
			);
			roots.push(root);
			const home = join(root, "home");
			const config = join(root, "config");
			const configDir = join(config, "opencode");
			const project = join(root, "conduit-config", "text-generation");
			const marker = join(root, "plugin-loaded");
			const plugin = join(root, "inherited-plugin.mjs");
			const wrapperBin = join(root, "bin");
			const wrapperRecords = join(root, "wrapper-processes");
			const sentinel = "TITLE_ISOLATION_INHERITED_SOURCE";
			const planted = [
				join(root, "CLAUDE.md"),
				join(root, "AGENTS.md"),
				join(root, "CONTEXT.md"),
				join(home, ".claude", "CLAUDE.md"),
				join(configDir, "AGENTS.md"),
			];
			for (const dir of [
				home,
				configDir,
				project,
				join(home, ".claude", "skills", "inherited-claude-skill"),
				join(configDir, "plugins"),
				join(configDir, "agents"),
				join(configDir, "skills", "inherited-opencode-skill"),
				join(root, ".opencode", "agents"),
				join(root, "data"),
				join(root, "state"),
				join(root, "cache"),
				wrapperBin,
				wrapperRecords,
			])
				mkdirSync(dir, { recursive: true });
			expect(realBinary).toBeDefined();
			const wrapper = join(wrapperBin, "opencode");
			// Reproduce an npm launcher that leaves its listener alive when only
			// the launcher receives SIGTERM. The production supervisor must own both.
			writeFileSync(
				wrapper,
				`#!${process.execPath}
const { spawn } = require("node:child_process");
const { readdirSync, renameSync, writeFileSync } = require("node:fs");
const { dirname } = require("node:path");
const environment = Object.fromEntries([
  "HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
  "OPENCODE_TEST_HOME", "OPENCODE_TEST_MANAGED_CONFIG_DIR", "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_EXTERNAL_SKILLS", "OPENCODE_PURE",
  "OPENCODE_DISABLE_DEFAULT_PLUGINS", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_AUTO_SHARE"
].map((key) => [key, process.env[key]]));
const record = {
  wrapperPid: process.pid, childPid: null,
  supervisorPid: Number(process.env.CONDUIT_OPENCODE_GROUP_PID),
  root: dirname(process.env.XDG_CONFIG_HOME), environment,
  configEntriesBeforeSpawn: readdirSync(process.env.XDG_CONFIG_HOME)
};
const file = ${JSON.stringify(wrapperRecords)} + "/" + process.pid + ".json";
const save = () => { writeFileSync(file + ".tmp", JSON.stringify(record)); renameSync(file + ".tmp", file); };
save();
const start = () => {
  const child = spawn(${JSON.stringify(realBinary)}, process.argv.slice(2), { stdio: "inherit" });
  child.on("spawn", () => { record.childPid = child.pid; save(); });
};
if (process.env.CONDUIT_TEST_TITLE_STARTUP_DELAY === "1") setTimeout(start, 10000);
else start();
`,
			);
			chmodSync(wrapper, 0o700);
			for (const file of planted) writeFileSync(file, sentinel);
			writeFileSync(
				plugin,
				`import { writeFileSync } from "node:fs";\nexport default async () => { writeFileSync(${JSON.stringify(marker)}, "loaded"); return {}; };\n`,
			);
			writeFileSync(
				join(configDir, "plugins", "inherited.mjs"),
				`export { default } from ${JSON.stringify(pathToFileURL(plugin).href)};\n`,
			);
			for (const file of [
				join(configDir, "agents", "inherited-agent.md"),
				join(root, ".opencode", "agents", "inherited-project-agent.md"),
			])
				writeFileSync(
					file,
					`---\ndescription: ${sentinel}\nmode: subagent\n---\n${sentinel}\n`,
				);
			for (const [parent, name] of [
				[join(home, ".claude", "skills"), "inherited-claude-skill"],
				[join(configDir, "skills"), "inherited-opencode-skill"],
			] as const)
				writeFileSync(
					join(parent, name, "SKILL.md"),
					`---\nname: ${name}\ndescription: ${sentinel}\n---\n${sentinel}\n`,
				);
			const inheritedConfig = {
				plugin: [pathToFileURL(plugin).href],
				instructions: planted,
				agent: {
					inherited_config_agent: { description: sentinel, prompt: sentinel },
				},
				mcp: {
					inherited_mcp: { type: "local", command: ["false"], enabled: false },
				},
			};
			const inheritedConfigPath = join(configDir, "opencode.json");
			writeFileSync(inheritedConfigPath, JSON.stringify(inheritedConfig));
			const provider = {
				isolation_probe: {
					npm: "@ai-sdk/openai-compatible",
					name: "Title isolation probe",
					options: { baseURL: "http://127.0.0.1:1/v1" },
					models: {
						"isolation-title": {
							name: "Isolation title",
							limit: { context: 1024, output: 32 },
						},
					},
				},
			};
			const forwarded = {
				provider,
				enabled_providers: ["isolation_probe"],
				disabled_providers: ["anthropic"],
			};
			const env = {
				PATH: `${wrapperBin}${delimiter}${process.env["PATH"] ?? ""}`,
				HOME: home,
				OPENCODE_TEST_HOME: home,
				XDG_CONFIG_HOME: config,
				XDG_DATA_HOME: join(root, "data"),
				XDG_STATE_HOME: join(root, "state"),
				XDG_CACHE_HOME: join(root, "cache"),
				OPENCODE_CONFIG: inheritedConfigPath,
				OPENCODE_CONFIG_DIR: configDir,
				OPENCODE_CONFIG_CONTENT: JSON.stringify(inheritedConfig),
				OPENCODE_SERVER_PASSWORD: "title-isolation-test-password",
			};
			const account = {
				driver: "opencode",
				id: AccountIdSchema.make("title-isolation"),
				name: "Title isolation",
				usageEligible: false,
				managed: true,
				env,
			} as const;
			// The actual fresh working directory has hostile ancestor instructions.
			vi.stubEnv("TMPDIR", root);
			const evidence: Record<string, unknown> = {
				version: binary.stdout.trim(),
				modelPrompts: 0,
				planted: {
					instructions: planted,
					plugin,
					config: inheritedConfigPath,
					home,
					project,
					wrapper,
				},
				limitations: [
					"OpenCode exposes no public endpoint for the assembled system prompt without a model request. Instruction exclusion is pinned to the startup flags and isolated paths, alongside observable config, agents and skills.",
					"Shared account auth can supply wellknown and console organization config. This fixture uses an empty data directory.",
					"macOS managed MDM plist configuration has no environment disable flag.",
				],
			};
			try {
				// Prove the planted sources load before testing their exclusion.
				if (!realBinary) throw new Error("Missing OpenCode binary");
				const controlPort = await availableOpenCodePort();
				const controlEnv = {
					...Object.fromEntries(
						Object.entries(process.env).filter(
							([key]) =>
								!key.startsWith("OPENCODE_DISABLE_") && key !== "OPENCODE_PURE",
						),
					),
					...env,
					OPENCODE_SERVER_USERNAME: "opencode",
				};
				const control = spawn(
					realBinary,
					["serve", "--hostname", "127.0.0.1", "--port", String(controlPort)],
					{ cwd: project, env: controlEnv, stdio: "ignore", detached: true },
				);
				let controlError: Error | undefined;
				control.once("error", (error) => {
					controlError = error;
				});
				try {
					await expect
						.poll(
							async () => {
								if (controlError) throw controlError;
								return Boolean(
									await probeOpenCodeHealth(controlPort, controlEnv),
								);
							},
							{ timeout: 30_000, interval: 100 },
						)
						.toBe(true);
					const response = await fetch(
						`http://127.0.0.1:${controlPort}/agent`,
						{
							headers: {
								Authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
							},
							signal: AbortSignal.timeout(45_000),
						},
					);
					expect(response.ok).toBe(true);
					const agents: unknown = await response.json();
					if (!Array.isArray(agents)) throw new Error("Missing control agents");
					const names = agents.map((agent: unknown) =>
						typeof agent === "object" && agent !== null && "name" in agent
							? agent.name
							: undefined,
					);
					expect(names).toEqual(
						expect.arrayContaining([
							"inherited-agent",
							"inherited-project-agent",
						]),
					);
					await expect
						.poll(() => existsSync(marker), { timeout: 5000, interval: 50 })
						.toBe(true);
					evidence["control"] = {
						agents: names,
						markerCreated: existsSync(marker),
					};
				} finally {
					if (control.pid !== undefined) {
						const pid = control.pid;
						const stop = (signal: NodeJS.Signals) => {
							try {
								process.kill(-pid, signal);
							} catch (error) {
								if (isProcessAlive(pid)) throw error;
							}
						};
						stop("SIGTERM");
						const force = setTimeout(() => stop("SIGKILL"), 3000);
						try {
							await expect
								.poll(() => isProcessAlive(pid), {
									timeout: 8000,
									interval: 50,
								})
								.toBe(false);
							await expect
								.poll(
									() => {
										try {
											process.kill(-pid, 0);
											return true;
										} catch {
											return false;
										}
									},
									{ timeout: 8000, interval: 50 },
								)
								.toBe(false);
						} finally {
							clearTimeout(force);
						}
					}
				}
				rmSync(marker);
				expect(existsSync(marker)).toBe(false);
				for (const interrupted of [false, true]) {
					const ready = Effect.runSync(
						Deferred.make<
							Effect.Success<ReturnType<typeof openCodeTextServerEffect>>
						>(),
					);
					const finish = Effect.runSync(Deferred.make<void>());
					const program = Effect.scoped(
						Effect.gen(function* () {
							const server = yield* openCodeTextServerEffect(account, {
								...inheritedConfig,
								...forwarded,
							});
							yield* Deferred.succeed(ready, server);
							return yield* interrupted ? Effect.never : Deferred.await(finish);
						}),
					);
					const fiber = Effect.runFork(program);
					const server = await Effect.runPromise(
						Effect.raceFirst(
							Deferred.await(ready),
							Fiber.join(fiber).pipe(Effect.andThen(Effect.never)),
						).pipe(
							Effect.timeout("35 seconds"),
							Effect.onError(() => Fiber.interrupt(fiber)),
						),
					);
					let observed: Record<string, unknown> = {};
					let sources: Record<string, unknown> = {};
					let startup:
						| ReturnType<typeof readWrapperRecords>[number]
						| undefined;
					let wrapperPids: number[] = [];
					let listenerPids: number[] = [];
					try {
						const records = readWrapperRecords(wrapperRecords).filter(
							(record) => isProcessAlive(record.wrapperPid),
						);
						expect(records).toHaveLength(1);
						startup = records[0];
						if (!startup || startup.childPid === null)
							throw new Error("Native listener did not spawn");
						wrapperPids = [startup.wrapperPid];
						listenerPids = [startup.childPid];
						expect(startup.environment).toMatchObject({
							HOME: home,
							XDG_CONFIG_HOME: join(server.root, "config"),
							XDG_DATA_HOME: env.XDG_DATA_HOME,
							OPENCODE_TEST_HOME: join(server.root, "home"),
							OPENCODE_TEST_MANAGED_CONFIG_DIR: join(server.root, "managed"),
							OPENCODE_DISABLE_PROJECT_CONFIG: "1",
							OPENCODE_DISABLE_CLAUDE_CODE: "1",
							OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
							OPENCODE_PURE: "1",
						});
						expect(startup.configEntriesBeforeSpawn).toEqual([]);
						expect(wrapperPids[0]).toBe(server.pid);
						expect(listenerPids.every(isProcessAlive)).toBe(true);
						expect(isProcessAlive(server.pid)).toBe(true);
						const [resolved, agents, skills, providers, path] =
							await Effect.runPromise(
								Effect.tryPromise(async () => {
									const session = await server.client.session.create();
									const reported = await Promise.all([
										server.client.config.get(),
										server.client.app.agents(),
										server.client.app.skills(server.cwd),
										server.client.provider.list(),
										server.client.app.path(server.cwd),
									]);
									await server.client.session.delete(session.id);
									return reported;
								}).pipe(Effect.timeout("25 seconds")),
							);
						observed = { config: resolved, agents, skills, providers, path };
						sources = {
							inheritedConfig: {
								passed: !JSON.stringify(resolved).includes(sentinel),
							},
							plugins: {
								passed: !existsSync(marker),
							},
							agents: {
								passed: !agents.some((agent) => agent.id.includes("inherited")),
							},
							skills: {
								passed: !skills.some((skill) =>
									skill.name.includes("inherited"),
								),
								builtInSkills: skills.map((skill) => skill.name),
							},
							globalOpenCodeInstructions: {
								passed: path.config === join(server.root, "config", "opencode"),
								evidence:
									"The reported config path excludes the planted global AGENTS.md.",
							},
							ancestorInstructions: {
								passed:
									startup.environment["OPENCODE_DISABLE_PROJECT_CONFIG"] ===
										"1" && server.cwd.startsWith(root),
								evidence:
									"Startup/source-backed; system prompt not observable without a model request.",
								ancestorWasPlanted: server.cwd.startsWith(root),
							},
							claudeInstructions: {
								passed:
									startup.environment["OPENCODE_DISABLE_CLAUDE_CODE"] === "1" &&
									startup.environment["OPENCODE_TEST_HOME"] ===
										join(server.root, "home"),
								evidence:
									"Startup/source-backed; system prompt not observable without a model request.",
							},
						};
						expect(resolved).toMatchObject(forwarded);
						expect(JSON.stringify(observed)).not.toContain(sentinel);
						expect(agents.map((agent) => agent.id)).toContain("title");
						expect(agents.some((agent) => agent.id.includes("inherited"))).toBe(
							false,
						);
						expect(
							skills.some((skill) => skill.name.includes("inherited")),
						).toBe(false);
						expect(
							providers.providers
								.find((item) => item.id === "isolation_probe")
								?.models?.some((model) => model.id === "isolation-title"),
						).toBe(true);
						expect(path.config).toBe(join(server.root, "config", "opencode"));
						expect(existsSync(marker)).toBe(false);
						expect(server.cwd.startsWith(root)).toBe(true);
						expect(server.cwd.startsWith(home)).toBe(false);
						expect(isProcessAlive(server.process.pid ?? 0)).toBe(true);
						if (!interrupted) {
							await Effect.runPromise(Deferred.succeed(finish, undefined));
							await Effect.runPromise(Fiber.join(fiber));
						}
					} finally {
						await Effect.runPromise(Fiber.interrupt(fiber));
						evidence[interrupted ? "interruption" : "completion"] = {
							observed,
							startup,
							sources,
							launchPid: server.pid,
							listenerPids,
							supervisorPid: server.process.pid,
							wrapperPids,
							root: server.root,
							cwd: server.cwd,
							checks: {
								pluginNotLoaded: !existsSync(marker),
								processGone: !isProcessAlive(server.process.pid ?? 0),
								listenersGone: listenerPids.every(
									(pid) => !isProcessAlive(pid),
								),
								wrappersGone: wrapperPids.every((pid) => !isProcessAlive(pid)),
								scratchRemoved: !existsSync(server.root),
							},
						};
					}
					expect(isProcessAlive(server.process.pid ?? 0)).toBe(false);
					expect(isProcessAlive(server.pid)).toBe(false);
					expect(listenerPids.every((pid) => !isProcessAlive(pid))).toBe(true);
					expect(wrapperPids.every((pid) => !isProcessAlive(pid))).toBe(true);
					expect(existsSync(server.root)).toBe(false);
				}

				let startupReady = false;
				const startingFiber = Effect.runFork(
					Effect.scoped(
						Effect.gen(function* () {
							yield* openCodeTextServerEffect(
								{
									...account,
									env: { ...env, CONDUIT_TEST_TITLE_STARTUP_DELAY: "1" },
								},
								forwarded,
							);
							startupReady = true;
							return yield* Effect.never;
						}),
					),
				);
				let starting: ReturnType<typeof readWrapperRecords>[number] | undefined;
				try {
					await expect
						.poll(
							() =>
								readWrapperRecords(wrapperRecords).filter(
									(record) =>
										isProcessAlive(record.wrapperPid) &&
										record.childPid === null,
								),
							{ timeout: 8000, interval: 50 },
						)
						.toHaveLength(1);
					starting = readWrapperRecords(wrapperRecords).find(
						(record) =>
							isProcessAlive(record.wrapperPid) && record.childPid === null,
					);
					if (!starting) throw new Error("Missing startup process evidence");
					expect(startupReady).toBe(false);
					expect(starting.childPid).toBeNull();
					expect(isProcessAlive(starting.supervisorPid)).toBe(true);
					expect(existsSync(starting.root)).toBe(true);
				} finally {
					await Effect.runPromise(Fiber.interrupt(startingFiber));
					if (starting)
						evidence["startupInterruption"] = {
							startup: starting,
							checks: {
								beforeReady: !startupReady,
								nativeProcessNeverStarted: starting.childPid === null,
								wrapperGone: !isProcessAlive(starting.wrapperPid),
								supervisorGone: !isProcessAlive(starting.supervisorPid),
								scratchRemoved: !existsSync(starting.root),
							},
						};
				}
				if (!starting) throw new Error("Missing startup process evidence");
				expect(isProcessAlive(starting.wrapperPid)).toBe(false);
				expect(isProcessAlive(starting.supervisorPid)).toBe(false);
				expect(existsSync(starting.root)).toBe(false);
				evidence["passed"] = true;
			} catch (error) {
				evidence["passed"] = false;
				evidence["error"] = String(error);
				evidence["failedProcessEvidence"] = readWrapperRecords(wrapperRecords);
				throw error;
			} finally {
				mkdirSync(join(process.cwd(), "test-results"), { recursive: true });
				writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
			}
		}, 120_000);
	},
);
