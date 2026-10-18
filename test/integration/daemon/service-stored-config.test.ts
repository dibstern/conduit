// Failure cases: persisted flags survive in service arguments, install drops
// explicit values or unrelated config, reinstall retains a stale unit or resets
// saved values, implicit TLS overrides saved TLS, restarts override later edits,
// foreground flags lose precedence, or stale supervised flags give no warning.
// Service-manager commands are faked; all service/config paths are temporary.
// Run after building with CONDUIT_TEST_DIST=dist and vitest.integration.config.ts.
// Evidence is JSON lines in test-results/service-stored-config/run.log.

import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { Result as Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createServiceRunner,
	generateServiceUnit,
	getServicePaths,
	handleService,
	type ServiceRunner,
} from "../../../src/bin/cli-service.js";
import { parseArgs } from "../../../src/bin/cli-utils.js";
import { GetStatus } from "../../../src/lib/contracts/ws-rpc.js";
import {
	loadDaemonConfigResult,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Worker threads keep their own process.env, so os.homedir() would still
// return the real home and the install would target ~/Library/LaunchAgents.
vi.mock("node:os", async (importOriginal) => {
	const os = await importOriginal<typeof import("node:os")>();
	return { ...os, homedir: () => process.env["HOME"] ?? os.homedir() };
});

const DIST = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
const RUN_LOG = join("test-results", "service-stored-config", "run.log");
const persistedFlags = [
	"--port",
	"-p",
	"--no-https",
	"--tailscale-serve",
	"--no-tailscale-serve",
];

function record(event: string, details: Record<string, unknown> = {}): void {
	appendFileSync(
		RUN_LOG,
		`${JSON.stringify({ time: new Date().toISOString(), event, ...details })}\n`,
	);
}

function unitArguments(unit: string): string[] {
	let program: string[];
	if (process.platform === "darwin") {
		const array = unit.match(
			/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
		)?.[1];
		if (!array) throw new Error("Missing ProgramArguments");
		program = [...array.matchAll(/<string>(.*?)<\/string>/g)].map((match) =>
			(match[1] ?? "")
				.replaceAll("&apos;", "'")
				.replaceAll("&quot;", '"')
				.replaceAll("&gt;", ">")
				.replaceAll("&lt;", "<")
				.replaceAll("&amp;", "&"),
		);
	} else {
		const execStart = unit.match(/^ExecStart=(.*)$/m)?.[1];
		if (!execStart) throw new Error("Missing ExecStart");
		program = [...execStart.matchAll(/"((?:\\.|[^"\\])*)"|(\S+)/g)].map(
			(match) =>
				(match[1] ?? match[2] ?? "")
					.replace(/\\(.)/g, "$1")
					.replaceAll("%%", "%")
					.replaceAll("$$", "$"),
		);
	}
	expect(program.slice(0, 3)).toEqual(["/bin/sh", "-l", "-c"]);
	const script = program[3];
	if (!script?.startsWith("exec conduit "))
		throw new Error(`Unexpected service command: ${script}`);
	// The retained flags in this scenario deliberately use single-word values.
	return script.slice("exec conduit ".length).split(" ");
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	return new Promise((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close(() => fail(new Error("Missing test port")));
				return;
			}
			server.close((error) => (error ? fail(error) : done(address.port)));
		});
	});
}

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
	"service stored config",
	() => {
		it("persists install options and uses later saved settings with the same unit arguments", async () => {
			mkdirSync(dirname(RUN_LOG), { recursive: true });
			writeFileSync(RUN_LOG, "");
			const harness = ProcessHarness.create({
				dist: DIST,
				foregroundCli: true,
			});
			const home = join(harness.root, "home");
			const xdg = join(harness.root, "xdg");
			vi.stubEnv("HOME", home);
			vi.stubEnv("XDG_CONFIG_HOME", xdg);
			vi.stubEnv("SHELL", "/bin/sh");
			const paths = getServicePaths(
				process.platform,
				home,
				harness.configDir,
				harness.projectDir,
				xdg,
			);
			const realRunner = createServiceRunner(async () => false);
			const runner: ServiceRunner = {
				...realRunner,
				exec: async (command, args) => {
					record("fake-service-command", { command, args });
					if (command === "launchctl" && args[0] === "print")
						return { code: 113, stdout: "", stderr: "Could not find service" };
					if (command === "systemctl" && args[1] === "show")
						return {
							code: 0,
							stdout: "LoadState=not-found\nMainPID=0\n",
							stderr: "",
						};
					return { code: 0, stdout: "", stderr: "" };
				},
				isPortAvailable: async () => true,
				readFile: async (path) => {
					expect(path).toBe(paths.unitFile);
					return realRunner.readFile(path);
				},
				loadConfig: (dir) => {
					expect(dir).toBe(harness.configDir);
					return realRunner.loadConfig(dir);
				},
				mkdir: async (path) => {
					expect(path.startsWith(`${harness.root}/`)).toBe(true);
					await realRunner.mkdir(path);
				},
				saveConfig: async (config, dir) => {
					expect(dir).toBe(harness.configDir);
					await realRunner.saveConfig(config, dir);
				},
				writeFile: async (path, content) => {
					expect(path).toBe(paths.unitFile);
					await realRunner.writeFile(path, content);
				},
			};
			async function install(flags: string[]): Promise<void> {
				const output: string[] = [];
				const errors: string[] = [];
				const exits: number[] = [];
				await handleService(
					{
						args: parseArgs(["service", "install", ...flags]),
						options: { configDir: harness.configDir },
						cwd: harness.projectDir,
						stdout: { write: (text) => void output.push(text) },
						stderr: { write: (text) => void errors.push(text) },
						exit: (code) => void exits.push(code),
						checkDaemon: async () => false,
					},
					runner,
				);
				record("install", { flags, output, errors, exits });
				expect(errors).toEqual([]);
				expect(exits).toEqual([]);
				expect(output.join("")).toContain("Installed Conduit service");
			}
			try {
				record("start", {
					root: harness.root,
					dist: DIST,
					platform: process.platform,
				});
				const seed = Either.getOrThrowWith(
					loadDaemonConfigResult(harness.configDir),
					(error) => error,
				);
				if (!seed) throw new Error("Missing harness config");
				await saveDaemonConfig(
					{ ...seed, autoSettleAfterDays: 7, debug: true },
					harness.configDir,
				);
				const installPort = await unusedPort();
				const claudeConfigDir = join(harness.root, "claude");
				const retained = [
					"--oc-port",
					"4999",
					"--host",
					"127.0.0.1",
					"--log-level",
					"warn",
					"--log-format",
					"json",
				];
				mkdirSync(dirname(paths.unitFile), { recursive: true });
				const staleUnit = generateServiceUnit({
					platform: process.platform,
					shell: "/bin/sh",
					command: ["conduit", "serve", "--port", "3000", "--no-https"],
					paths,
				});
				writeFileSync(paths.unitFile, staleUnit);
				await install([
					"--port",
					String(installPort),
					"--claude-config-dir",
					claudeConfigDir,
					"--no-https",
					"--no-tailscale-serve",
					...retained,
				]);
				const installed = Either.getOrThrowWith(
					loadDaemonConfigResult(harness.configDir),
					(error) => error,
				);
				expect(installed).toMatchObject({
					port: installPort,
					tls: false,
					tailscaleServe: false,
					autoSettleAfterDays: 7,
					debug: true,
					projects: seed.projects,
				});
				expect(installed).not.toHaveProperty("claudeConfigDir");
				expect(
					installed.instances?.find(({ id }) => id === "claude"),
				).not.toHaveProperty("configDir");
				const unit = readFileSync(paths.unitFile, "utf8");
				expect(unit).not.toBe(staleUnit);
				const args = unitArguments(unit);
				expect(args[0]).toBe("serve");
				for (const flag of persistedFlags) expect(args).not.toContain(flag);
				for (const flag of retained) expect(args).toContain(flag);
				expect(
					args.slice(
						args.indexOf("--claude-config-dir"),
						args.indexOf("--claude-config-dir") + 2,
					),
				).toEqual(["--claude-config-dir", claudeConfigDir]);
				record("installed-unit", { args, unit, config: installed });
				await install([...retained, "--claude-config-dir", claudeConfigDir]);
				expect(
					Either.getOrThrowWith(
						loadDaemonConfigResult(harness.configDir),
						(error) => error,
					),
				).toEqual(installed);
				expect(unitArguments(readFileSync(paths.unitFile, "utf8"))).toEqual(
					args,
				);
				const start = (cliArgs: string[], supervised = true) =>
					harness.restart({
						cliArgs,
						exactCliArgs: true,
						skipBrowserProbe: true,
						startupTimeoutMs: 60_000,
						serviceEnvironment: { CONDUIT_SERVICE: supervised ? "1" : "0" },
					});
				await start(args);
				const initial = await harness.requestRpc(new GetStatus({}));
				expect(initial).toMatchObject({ port: installPort, tlsEnabled: false });
				expect(harness.logTail).not.toContain("re-run conduit service install");
				record("initial-daemon", {
					args,
					status: initial,
					logs: harness.logTail,
				});
				await harness.terminate();
				const stopped = Either.getOrThrowWith(
					loadDaemonConfigResult(harness.configDir),
					(error) => error,
				);
				if (!stopped) throw new Error("Missing stopped config");
				const changedPort = await unusedPort();
				const changedClaudeDir = join(harness.root, "another-claude-profile");
				mkdirSync(changedClaudeDir);
				await saveDaemonConfig(
					{
						...stopped,
						port: changedPort,
						instances: (stopped.instances ?? []).map((instance) =>
							instance.id === "claude"
								? { ...instance, configDir: changedClaudeDir }
								: instance,
						),
					},
					harness.configDir,
				);
				record("stored-edit", {
					port: changedPort,
					claudeConfigDir: changedClaudeDir,
				});
				await start(args);
				const restarted = await harness.requestRpc(new GetStatus({}));
				expect(restarted).toMatchObject({
					port: changedPort,
					tlsEnabled: false,
				});
				expect(
					Either.getOrThrowWith(
						loadDaemonConfigResult(harness.configDir),
						(error) => error,
					)?.instances?.find(({ id }) => id === "claude")?.configDir,
				).toBe(changedClaudeDir);
				record("restarted-daemon", {
					args,
					status: restarted,
					logs: harness.logTail,
				});
				await harness.terminate();
				const explicitArgs = [...args, "--port", String(installPort)];
				await start(explicitArgs, false);
				const foreground = await harness.requestRpc(new GetStatus({}));
				expect(foreground.port).toBe(installPort);
				expect(harness.logTail).not.toContain("re-run conduit service install");
				record("foreground-override", {
					args: explicitArgs,
					status: foreground,
				});
				await harness.terminate();
				await start([...explicitArgs, "--no-https", "--no-tailscale-serve"]);
				expect(
					harness.logTail.match(/re-run conduit service install/g),
				).toHaveLength(1);
				expect(readFileSync(paths.unitFile, "utf8")).toBe(unit);
				record("stale-service-warning", { logs: harness.logTail });
			} catch (error) {
				record("failed", { error: String(error), logs: harness.logTail });
				throw error;
			} finally {
				await harness.dispose().catch((error: unknown) => {
					record("cleanup-failed", { error: String(error) });
					throw error;
				});
				record("cleanup", { root: harness.root });
			}
			record("passed");
		}, 300_000);
	},
);
