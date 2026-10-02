import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: a server signal uses explicit-stop semantics, replacement
// respawns OpenCode, or explicit CLI stop leaves the process or its child alive.
describe("managed OpenCode through CLI server replacement", () => {
	let harness: ProcessHarness | undefined;
	const cliProcesses: Array<{
		child: ChildProcess;
		exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	}> = [];
	let result: Record<string, unknown> = { passed: false };
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const recorded = () => {
		if (!harness) throw new Error("No process harness");
		const instance = loadDaemonConfig(
			join(harness.root, "config"),
		)?.instances?.find((instance) => instance.id === "managed-test");
		if (!instance) throw new Error("Managed instance record missing");
		return instance;
	};
	const health = async () => {
		const instance = recorded();
		const response = await fetch(
			`http://127.0.0.1:${instance.port}/global/health`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"]}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
				},
				signal: AbortSignal.timeout(2000),
			},
		);
		expect(response.ok).toBe(true);
		return (await response.json()) as { pid: number; childPid: number };
	};
	const spawnCli = (args: string[]) => {
		if (!harness) throw new Error("No process harness");
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				fileURLToPath(new URL("../../../src/bin/cli.ts", import.meta.url)),
				...args,
			],
			{
				cwd: harness.projectDir,
				env: {
					PATH: `${join(harness.root, "bin")}:${process.env["PATH"] ?? ""}`,
					HOME: join(harness.root, "home"),
					XDG_CONFIG_HOME: join(harness.root, "config"),
					XDG_CACHE_HOME: join(harness.root, "cache"),
					XDG_DATA_HOME: join(harness.root, "data"),
					CONDUIT_CONFIG_DIR: join(harness.root, "config"),
					CLAUDE_CONFIG_DIR: join(harness.root, "claude"),
					CONDUIT_TEST_CLAUDE_QUERY_MODULE: pathToFileURL(
						fileURLToPath(
							new URL(
								"../../helpers/fake-claude-process-sdk.ts",
								import.meta.url,
							),
						),
					).href,
					OPENCODE_URL: "http://127.0.0.1:0",
					NODE_ENV: "test",
					LOG_LEVEL: "error",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		for (const stream of [child.stdout, child.stderr]) {
			stream?.on("data", (data: Buffer) => {
				output = (output + data.toString()).slice(-8000);
			});
		}
		const exit = new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((done, fail) => {
			child.once("exit", (code, signal) => done({ code, signal }));
			child.once("error", fail);
		});
		cliProcesses.push({ child, exit });
		return { child, exit, output: () => output };
	};

	afterEach(async () => {
		for (const { child, exit } of cliProcesses) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			child.kill("SIGTERM");
			const force = setTimeout(() => child.kill("SIGKILL"), 3000);
			try {
				await exit;
			} finally {
				clearTimeout(force);
			}
		}
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-12-cli-restart.json",
			JSON.stringify({ ticket: "conduit-test-85kb.12", ...result }, null, 2),
		);
	});

	it("preserves the same OpenCode PID after SIGTERM and serve, then terminates it on stop", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		const port = recorded().port;
		const daemonBefore = harness.generations[0];
		if (!daemonBefore) throw new Error("Initial daemon generation missing");
		expect(recorded().pid).toBe(before.pid);

		await harness.terminate();
		expect(daemonBefore.exitCode).toBe(0);
		expect(alive(before.pid)).toBe(true);
		const replacement = spawnCli([
			"serve",
			"--port",
			String(daemonBefore.port),
			"--host",
			"127.0.0.1",
			"--no-https",
		]);
		await vi.waitFor(() => expect(replacement.output()).toContain("Ready."), {
			timeout: 15_000,
		});
		expect(replacement.child.pid).not.toBe(daemonBefore.pid);
		expect(alive(before.pid)).toBe(true);
		const after = await health();
		const afterRecord = recorded();
		expect(after).toEqual(before);
		expect(afterRecord.pid).toBe(before.pid);
		expect(afterRecord.port).toBe(port);

		const stop = spawnCli(["stop"]);
		await vi.waitFor(() => expect(stop.child.exitCode).toBe(0), {
			timeout: 15_000,
		});
		expect(stop.output()).toMatch(/(?:server|daemon) stopped\./i);
		await vi.waitFor(() => expect(replacement.child.exitCode).toBe(0), {
			timeout: 5000,
		});
		await vi.waitFor(
			() => {
				expect(alive(before.pid)).toBe(false);
				expect(alive(before.childPid)).toBe(false);
			},
			{ timeout: 5000 },
		);
		expect(recorded().pid).toBeUndefined();
		result = {
			passed: true,
			daemonPidBefore: daemonBefore.pid,
			daemonPidAfter: replacement.child.pid,
			opencodePidBefore: before.pid,
			opencodePidAfter: after.pid,
			portBefore: port,
			portAfter: afterRecord.port,
			childPid: before.childPid,
			explicitStopTerminatedBoth: true,
		};
	});
});
