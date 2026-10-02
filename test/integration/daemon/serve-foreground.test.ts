import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Run after building: CONDUIT_TEST_DIST=dist npx --no-install vitest run
// --config vitest.integration.config.ts test/integration/daemon/serve-foreground.test.ts
// Failure cases: signals kill durable children, replacement respawns them,
// stop leaves children, concurrent serve disturbs the listener, or CLI commands
// create detached servers or PID files.
const DIST = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
const { PtyHostClient } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-client.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-client.js");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		if (cause instanceof Error && "code" in cause) {
			if (cause.code === "ESRCH") return false;
			if (cause.code === "EPERM") return true;
		}
		throw cause;
	}
}

describe("foreground conduit serve", () => {
	let harness: ProcessHarness | undefined;
	const pids = new Set<number>();
	const scenarios: Array<Record<string, unknown>> = [];
	const cleanup: Array<Record<string, unknown>> = [];

	function noPidArtifacts(): void {
		if (!harness) throw new Error("No process harness");
		expect(
			readdirSync(harness.configDir, { recursive: true }).filter((path) =>
				String(path).endsWith(".pid"),
			),
		).toEqual([]);
	}

	async function openCodeHealth() {
		if (!harness) throw new Error("No process harness");
		const instance = loadDaemonConfig(harness.configDir)?.instances?.find(
			(entry) => entry.id === "managed-test",
		);
		if (!instance?.processIdentity)
			throw new Error("Managed OpenCode identity is missing");
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
		const health = (await response.json()) as {
			pid: number;
			childPid: number;
		};
		for (const pid of [
			health.pid,
			health.childPid,
			instance.processIdentity.supervisorPid,
		])
			pids.add(pid);
		return { health, identity: instance.processIdentity, port: instance.port };
	}

	afterEach(async (context) => {
		if (!harness) return;
		const root = harness.root;
		for (const generation of harness.generations) pids.add(generation.pid);
		for (const pid of harness.runnerPids()) pids.add(pid);
		for (const pid of harness.ownedOpenCodePids()) pids.add(pid);
		for (const pid of harness.cliPids) pids.add(pid);
		let verified = false;
		let remaining: string[] = [];
		let processTable: {
			available: boolean;
			method?: "ps" | "lsof";
			error?: string;
		} = {
			available: false,
		};
		try {
			await harness.dispose();
			await vi.waitFor(() => expect([...pids].filter(alive)).toEqual([]), {
				timeout: 5000,
			});
			try {
				remaining = execFileSync("ps", ["-axo", "pid,command"], {
					encoding: "utf8",
					maxBuffer: 8 * 1024 * 1024,
					stdio: ["ignore", "pipe", "pipe"],
				})
					.split("\n")
					.filter((line) => {
						const pid = Number(line.trim().split(/\s+/, 1)[0]);
						return pids.has(pid) || line.includes(root);
					});
				processTable = { available: true, method: "ps" };
			} catch (cause) {
				processTable = {
					available: false,
					error: cause instanceof Error ? cause.message : String(cause),
				};
				try {
					// cwd remains identifiable even after the isolated root is deleted.
					const snapshot = execFileSync("lsof", ["-d", "cwd", "-F", "pcn"], {
						encoding: "utf8",
						maxBuffer: 8 * 1024 * 1024,
						stdio: ["ignore", "pipe", "pipe"],
					});
					let processEntry = "";
					for (const line of snapshot.split("\n")) {
						if (line.startsWith("p")) processEntry = line.slice(1);
						else if (line.startsWith("c")) processEntry += ` ${line.slice(1)}`;
						else if (line.startsWith("n") && line.includes(root))
							remaining.push(`${processEntry} ${line.slice(1)}`);
					}
					processTable = { ...processTable, available: true, method: "lsof" };
				} catch (fallbackCause) {
					processTable.error += `\nlsof: ${String(fallbackCause)}`;
				}
			}
			expect(remaining).toEqual([]);
			verified = true;
		} finally {
			cleanup.push({
				test: context.task.name,
				root,
				pids: [...pids],
				remaining,
				remainingPids: [...pids].filter(alive),
				processTable,
				verified,
				passed: context.task.result?.state !== "fail",
				proof: harness.proof(),
			});
			harness = undefined;
			pids.clear();
		}
	});

	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-16-serve.json",
			JSON.stringify(
				{
					ticket: "conduit-test-85kb.16",
					dist: DIST,
					passed:
						scenarios.length === 5 &&
						cleanup.length === 5 &&
						cleanup.every((entry) => entry["passed"] && entry["verified"]),
					scenarios,
					cleanup,
				},
				null,
				2,
			),
		);
	});

	it.each([
		"SIGINT",
		"SIGTERM",
	] as const)("preserves and re-adopts subprocesses after %s, then stops them explicitly", async (signal) => {
		harness = await ProcessHarness.start({
			dist: DIST,
			foregroundCli: true,
			claudeRunner: "process",
			managedOpenCode: true,
			restartProof: true,
		});
		const initial = harness.generations[0];
		if (!initial) throw new Error("Initial server generation missing");
		pids.add(initial.pid);
		const browser = await harness.connect();
		const sessionId = await browser.createSession(`serve-${signal}`);
		await browser.send(sessionId, `before-${signal}`);
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Claude runner identity missing");
		pids.add(runner.pid);
		const pty = await browser.createPty();
		pids.add(pty.pid);
		const host = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		const hostPid = host.hello.pid;
		pids.add(hostPid);
		host.disconnect();
		const before = await openCodeHealth();
		noPidArtifacts();

		await harness.signal(signal);
		expect(initial.exitCode).toBe(0);
		expect(initial.signal).toBeNull();
		expect(alive(initial.pid)).toBe(false);
		for (const pid of [
			runner.pid,
			hostPid,
			pty.pid,
			before.health.pid,
			before.health.childPid,
		])
			expect(alive(pid)).toBe(true);
		expect(await openCodeHealth()).toEqual(before);
		noPidArtifacts();

		await harness.restart();
		const replacement = harness.generations[1];
		if (!replacement) throw new Error("Replacement server generation missing");
		pids.add(replacement.pid);
		expect(replacement.pid).not.toBe(initial.pid);
		const reconnected = await harness.connect(sessionId);
		expect(
			(await reconnected.send(sessionId, `after-${signal}`)).chunks.join(""),
		).toContain(`Echo(after-${signal})`);
		expect(harness.runnerPids()).toEqual([runner.pid]);
		expect(await reconnected.listPtys()).toContainEqual(
			expect.objectContaining({ id: pty.id, pid: pty.pid, status: "running" }),
		);
		const adopted = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		expect(adopted.hello.pid).toBe(hostPid);
		adopted.disconnect();
		expect(await openCodeHealth()).toEqual(before);
		noPidArtifacts();

		const stopCommand = harness.runCli(["stop"]);
		const racingPty = await reconnected.createPty().then(
			(created) => {
				pids.add(created.pid);
				return created;
			},
			() => undefined,
		);
		const stop = await stopCommand;
		expect(stop.code).toBe(0);
		expect(stop.signal).toBeNull();
		await harness.waitForExit({ keepBrowsersOpen: true });
		expect(replacement.exitCode).toBe(0);
		await vi.waitFor(() => expect([...pids].filter(alive)).toEqual([]), {
			timeout: 5000,
		});
		expect((await harness.runCli(["stop"])).code).toBe(0);
		noPidArtifacts();
		scenarios.push({
			signal,
			initial,
			replacement,
			runner,
			hostPid,
			shellPid: pty.pid,
			openCode: before,
			racingPty,
			racingPtyAccepted: racingPty !== undefined,
			explicitStopTerminatedAll: true,
			pidArtifacts: [],
		});
	}, 60_000);

	it("stops preserved runners before a browser attaches to the replacement server", async () => {
		harness = await ProcessHarness.start({
			dist: DIST,
			foregroundCli: true,
			claudeRunner: "process",
		});
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"stop-before-browser-attachment",
		);
		await browser.send(sessionId, "warm-before-stop");
		const runner = harness.marks.find((mark) => mark.kind === "runner-started");
		if (runner?.kind !== "runner-started")
			throw new Error("Claude runner identity missing");
		pids.add(runner.pid);
		await harness.signal("SIGINT");
		expect(alive(runner.pid)).toBe(true);
		await harness.restart({ skipBrowserProbe: true });
		const replacement = harness.generations[1];
		if (!replacement) throw new Error("Replacement server generation missing");
		const stop = await harness.runCli(["stop"]);
		expect(stop.code).toBe(0);
		await harness.waitForExit();
		expect(replacement.exitCode).toBe(0);
		await vi.waitFor(() => expect(alive(runner.pid)).toBe(false), {
			timeout: 5000,
		});
		noPidArtifacts();
		scenarios.push({
			withoutBrowserAttachment: true,
			runner,
			replacement,
			stop,
		});
	}, 45_000);

	it("exits immediately on a second SIGINT during graceful shutdown", async () => {
		harness = await ProcessHarness.start({ dist: DIST, foregroundCli: true });
		const server = harness.generations[0];
		if (!server) throw new Error("Server generation missing");
		pids.add(server.pid);
		const socketPath = join(harness.configDir, "relay.sock");
		const shutdown = harness.signal("SIGINT");
		try {
			// Socket removal proves that graceful disposal has begun.
			await vi.waitFor(() => expect(existsSync(socketPath)).toBe(false), {
				interval: 10,
				timeout: 2000,
			});
			expect(alive(server.pid)).toBe(true);
			const secondAt = performance.now();
			process.kill(server.pid, "SIGINT");
			await shutdown;
			const elapsedMs = performance.now() - secondAt;
			expect(server.exitCode).toBe(0);
			expect(server.signal).toBeNull();
			expect(elapsedMs).toBeLessThan(1500);
			scenarios.push({ secondInterrupt: true, server, elapsedMs });
		} finally {
			await shutdown;
		}
	}, 30_000);

	it("rejects another serve without disturbing the server and accepts the hidden foreground alias", async () => {
		harness = await ProcessHarness.start({ dist: DIST, foregroundCli: true });
		const first = harness.generations[0];
		if (!first) throw new Error("Initial server generation missing");
		const presentBare = await harness.runCli([]);
		expect(presentBare.code).toBe(0);
		expect(presentBare.output).toContain(String(first.port));
		expect(alive(first.pid)).toBe(true);
		const duplicate = await harness.runCli([
			"serve",
			"--port",
			String(first.port),
			"--host",
			"127.0.0.1",
			"--no-https",
		]);
		expect(duplicate.code).toBe(1);
		expect(duplicate.output).toMatch(
			/already running|already listening|already in use/i,
		);
		expect(alive(first.pid)).toBe(true);
		const browser = await harness.connect();
		expect((await browser.daemonStatus()).port).toBe(first.port);
		await browser.close();
		await harness.signal("SIGINT");
		await harness.restart({ cliArgs: ["--foreground"] });
		const alias = harness.generations[1];
		if (!alias) throw new Error("Alias server generation missing");
		expect(alias.pid).not.toBe(first.pid);
		noPidArtifacts();
		expect((await harness.runCli(["stop"])).code).toBe(0);
		await harness.waitForExit();
		const absentBare = await harness.runCli([]);
		expect(absentBare.code).toBe(1);
		expect(absentBare.output).toBe(
			"Server is not running. Run conduit serve or conduit service install.\n",
		);
		expect(existsSync(join(harness.configDir, "relay.sock"))).toBe(false);
		scenarios.push({
			duplicate,
			presentBare,
			absentBare,
			first,
			alias,
			hiddenAliasForeground: true,
			absentBareCliGuidance: true,
		});
	}, 45_000);
});
