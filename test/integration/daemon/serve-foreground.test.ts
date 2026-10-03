import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
	AddProject,
	GetStatus,
	RemoveProject,
	Shutdown,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { inspectManagedOpenCodeProcess } from "../../../src/lib/instance/managed-opencode-process.js";
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

	async function warmProject(projectSlug: string, directory?: string) {
		if (!harness) throw new Error("No process harness");
		if (directory) {
			mkdirSync(directory);
			await sendRpcRequest(
				join(harness.configDir, "relay.sock"),
				new AddProject({ directory }),
			);
		}
		const browser = await harness.connect(undefined, undefined, projectSlug);
		const sessionId = await browser.createSession(`recovery-${projectSlug}`);
		await browser.send(sessionId, `warm-${projectSlug}`);
		const runner = harness.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (runner?.kind !== "runner-started")
			throw new Error(`Missing runner for ${projectSlug}`);
		pids.add(runner.pid);
		return { projectSlug, sessionId, runner, browser };
	}

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
					expectedScenarios: 11,
					passed:
						scenarios.length === 11 &&
						cleanup.length === 11 &&
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

	// Recovery failures must be local to one project. Signals cannot weaken a
	// later explicit stop or an ordinary project removal while recovery waits.
	it("keeps healthy projects usable when one persisted project cannot recover its relay", async () => {
		harness = await ProcessHarness.start({
			dist: DIST,
			foregroundCli: true,
			claudeRunner: "process",
		});
		const failed = await warmProject("process-test");
		const healthy = await warmProject(
			"healthy-project",
			join(harness.root, "healthy-project"),
		);
		await harness.signal("SIGINT");
		const database = join(harness.projectDir, ".conduit", "events.db");
		const original = readFileSync(database);
		writeFileSync(
			database,
			"isolated recovery failure: invalid SQLite database",
		);
		try {
			await harness.restart({ skipBrowserProbe: true });
			const replacement = harness.generations.at(-1);
			if (!replacement) throw new Error("Missing replacement generation");
			expect(alive(failed.runner.pid)).toBe(true);
			const browser = await harness.connect(
				healthy.sessionId,
				undefined,
				healthy.projectSlug,
			);
			expect(
				(
					await browser.send(
						healthy.sessionId,
						"healthy-after-recovery-failure",
					)
				).chunks.join(""),
			).toContain("Echo(healthy-after-recovery-failure)");
			expect(alive(replacement.pid)).toBe(true);
			expect(alive(failed.runner.pid)).toBe(true);
			scenarios.push({
				isolatedRecoveryFailure: true,
				failed: failed.runner,
				healthy: healthy.runner,
				replacement,
			});
		} finally {
			writeFileSync(database, original);
		}
	}, 60_000);

	it("lets explicit Shutdown override SIGINT while eager recovery is pending", async () => {
		harness = await ProcessHarness.start({
			dist: DIST,
			foregroundCli: true,
			claudeRunner: "process",
			managedOpenCode: true,
		});
		const project = await warmProject("process-test");
		const pty = await project.browser.createPty();
		pids.add(pty.pid);
		const host = await PtyHostClient.connect({
			configDir: harness.configDir,
			start: false,
		});
		pids.add(host.hello.pid);
		host.disconnect();
		await openCodeHealth();
		await harness.signal("SIGINT");
		const marker = join(harness.projectDir, ".conduit", "recovery-gated");
		const release = `${marker}-release`;
		writeFileSync(marker, "hold eager recovery");
		const interruptMarker = join(harness.root, "sigint-observed");
		rmSync(interruptMarker, { force: true });
		try {
			await harness.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => expect(existsSync(`${marker}-started`)).toBe(true),
				{ timeout: 5000 },
			);
			const replacement = harness.generations.at(-1);
			if (!replacement) throw new Error("Missing replacement generation");
			process.kill(replacement.pid, "SIGINT");
			await vi.waitFor(() => expect(existsSync(interruptMarker)).toBe(true));
			const response = await sendRpcRequest(
				join(harness.configDir, "relay.sock"),
				new Shutdown({}),
			);
			expect(response).toEqual({ ok: true });
			writeFileSync(release, "finish recovery");
			await harness.waitForExit();
			expect(replacement.exitCode).toBe(0);
			const children = [...pids];
			await vi.waitFor(() => expect(children.filter(alive)).toEqual([]), {
				timeout: 5000,
			});
			scenarios.push({
				explicitStopOverridesRestart: true,
				response,
				children,
				replacement,
			});
		} finally {
			writeFileSync(release, "finish recovery");
		}
	}, 60_000);

	it("terminates a removed project's runner while another project is recovering", async () => {
		harness = await ProcessHarness.start({
			dist: DIST,
			foregroundCli: true,
			claudeRunner: "process",
		});
		const removed = await warmProject("process-test");
		const recoveringDirectory = join(harness.root, "recovering-project");
		const recovering = await warmProject(
			"recovering-project",
			recoveringDirectory,
		);
		await harness.signal("SIGINT");
		const marker = join(recoveringDirectory, ".conduit", "recovery-gated");
		const release = `${marker}-release`;
		writeFileSync(marker, "hold second project recovery");
		try {
			await harness.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => expect(existsSync(`${marker}-started`)).toBe(true),
				{ timeout: 5000 },
			);
			const adopted = await harness.connect(
				removed.sessionId,
				undefined,
				removed.projectSlug,
			);
			expect(
				(
					await adopted.send(removed.sessionId, "adopt-before-remove")
				).chunks.join(""),
			).toContain("Echo(adopt-before-remove)");
			await adopted.close();
			const response = await sendRpcRequest(
				join(harness.configDir, "relay.sock"),
				new RemoveProject({ slug: "process-test" }),
			);
			expect(response.projects.map((project) => project.slug)).not.toContain(
				removed.projectSlug,
			);
			await vi.waitFor(() => expect(alive(removed.runner.pid)).toBe(false), {
				timeout: 5000,
			});
			expect(alive(recovering.runner.pid)).toBe(true);
			expect(existsSync(release)).toBe(false);
			const status = await sendRpcRequest(
				join(harness.configDir, "relay.sock"),
				new GetStatus({}),
			);
			expect(status.projects.map((project) => project.slug)).not.toContain(
				"process-test",
			);
			scenarios.push({
				removalDuringRecovery: true,
				removed: removed.runner,
				recovering: recovering.runner,
				response,
			});
		} finally {
			writeFileSync(release, "finish recovery");
		}
	}, 60_000);

	it("preserves an adopted runner when its relay fails after recovery", async () => {
		harness = await ProcessHarness.start({
			dist: DIST,
			foregroundCli: true,
			claudeRunner: "process",
		});
		const healthy = await warmProject("process-test");
		const failedDirectory = join(harness.root, "rollback-project");
		const failed = await warmProject("rollback-project", failedDirectory);
		await harness.signal("SIGINT");
		const marker = join(
			failedDirectory,
			".conduit",
			"recovery-fail-after-adoption",
		);
		const release = `${marker}-release`;
		writeFileSync(marker, "fail only after recovery authenticated the runner");
		try {
			await harness.restart({ skipBrowserProbe: true });
			await vi.waitFor(
				() => expect(existsSync(`${marker}-started`)).toBe(true),
				{ timeout: 5000 },
			);
			expect(alive(failed.runner.pid)).toBe(true);
			const adopted = await harness.connect(
				healthy.sessionId,
				undefined,
				healthy.projectSlug,
			);
			expect(
				(
					await adopted.send(healthy.sessionId, "adopt-before-rollback")
				).chunks.join(""),
			).toContain("Echo(adopt-before-rollback)");
			await adopted.close();
			const removal = await sendRpcRequest(
				join(harness.configDir, "relay.sock"),
				new RemoveProject({ slug: healthy.projectSlug }),
			);
			expect(removal.projects.map((project) => project.slug)).not.toContain(
				healthy.projectSlug,
			);
			expect(existsSync(release)).toBe(false);
			writeFileSync(release, "fail the partially acquired relay");
			await vi.waitFor(() => expect(existsSync(`${marker}-failed`)).toBe(true));
			const fresh = await warmProject(
				"fresh-project",
				join(harness.root, "fresh-project"),
			);
			expect(alive(failed.runner.pid)).toBe(true);
			await vi.waitFor(() => expect(alive(healthy.runner.pid)).toBe(false), {
				timeout: 5000,
			});
			scenarios.push({
				rollbackAfterAdoption: true,
				failed: failed.runner,
				removed: healthy.runner,
				fresh: fresh.runner,
				removal,
			});
		} finally {
			writeFileSync(release, "release recovery fixture for cleanup");
		}
	}, 60_000);

	// A managed option is not required for CLI smart-default to spawn. Its
	// authenticated supervisor and delayed child must end before root removal.
	it("awaits every managed fixture process after startup failure without a managed option", async () => {
		harness = ProcessHarness.create({
			dist: DIST,
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		const executable = join(harness.root, "bin", "opencode");
		writeFileSync(
			executable,
			`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const configDir = process.env.CONDUIT_CONFIG_DIR;
const args = process.argv.slice(2);
const port = Number(args.find(arg => arg.startsWith("--port="))?.split("=")[1] ?? args[args.indexOf("--port") + 1]);
const child = spawn(process.execPath, ["-e", 'setTimeout(() => process.exit(0), 25000); process.on("SIGTERM", () => setTimeout(() => process.exit(0), 7000)); process.send("ready");'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
await new Promise(done => child.once("message", done));
child.disconnect();
child.unref();
appendFileSync(join(configDir, "fake-opencode-pids.jsonl"), JSON.stringify({ pid: process.pid, childPid: child.pid, groupPid: Number(process.env.CONDUIT_OPENCODE_GROUP_PID) }) + "\\n");
createServer((request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ healthy: true, version: "cleanup-fixture", pid: process.pid, childPid: child.pid })); }).listen(port, "127.0.0.1");
process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(0); });
`,
		);
		chmodSync(executable, 0o755);
		mkdirSync(join(harness.projectDir, ".conduit"));
		writeFileSync(
			join(harness.projectDir, ".conduit", "events.db"),
			"invalid fixture database",
		);
		await expect(harness.restart()).rejects.toThrow();
		const record = JSON.parse(
			readFileSync(
				join(harness.configDir, "fake-opencode-pids.jsonl"),
				"utf8",
			).trim(),
		) as { pid: number; childPid: number; groupPid: number };
		for (const pid of [record.pid, record.childPid, record.groupPid])
			pids.add(pid);
		const root = harness.root;
		const owned = harness.ownedOpenCodePids();
		expect(owned).toContain(record.groupPid);
		const instance = loadDaemonConfig(harness.configDir)?.instances?.find(
			(candidate) =>
				candidate.processIdentity?.supervisorPid === record.groupPid,
		);
		const authenticated = await inspectManagedOpenCodeProcess(
			instance?.processIdentity,
		);
		expect(authenticated?.pid).toBe(record.pid);
		writeFileSync(
			join(harness.configDir, "daemon.json"),
			"invalid fixture config",
		);
		const cleanupStarted = Date.now();
		await harness.dispose();
		expect([...pids].filter(alive)).toEqual([]);
		expect(existsSync(root)).toBe(false);
		scenarios.push({
			startupFailureCleanup: true,
			record,
			owned,
			authenticated,
			cleanupDurationMs: Date.now() - cleanupStarted,
			allTerminatedBeforeRemoval: true,
		});
	}, 60_000);

	it("awaits observed fixture children when startup cannot persist any managed identity", async () => {
		harness = ProcessHarness.create({
			dist: DIST,
			foregroundCli: true,
			autoStartOpenCode: true,
		});
		const gate = join(harness.root, "managed-identity-save-gated");
		const release = `${gate}-release`;
		const fault = join(harness.root, "managed-identity-persistence-fault.json");
		writeFileSync(gate, "hold only the first managed identity rename");
		const executable = join(harness.root, "bin", "opencode");
		writeFileSync(
			executable,
			`#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const configDir = process.env.CONDUIT_CONFIG_DIR;
const root = join(configDir, "..");
if (process.env.HOME !== join(root, "home")) throw new Error("Fixture requires isolated HOME");
const gate = join(root, "managed-identity-save-gated");
const args = process.argv.slice(2);
const port = Number(args.find(arg => arg.startsWith("--port="))?.split("=")[1] ?? args[args.indexOf("--port") + 1]);
const child = spawn(process.execPath, ["-e", 'setTimeout(() => process.exit(0), 25000); process.on("SIGTERM", () => setTimeout(() => process.exit(0), 7000)); process.send("ready");'], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
process.on("SIGTERM", () => { child.kill("SIGTERM"); process.exit(0); });
await new Promise(done => child.once("message", done));
child.disconnect();
child.unref();
appendFileSync(join(configDir, "fake-opencode-pids.jsonl"), JSON.stringify({ pid: process.pid, childPid: child.pid, groupPid: Number(process.env.CONDUIT_OPENCODE_GROUP_PID) }) + "\\n");
createServer((request, response) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ healthy: true, version: "pre-persistence-fixture" })); }).listen(port, "127.0.0.1");
while (!existsSync(gate + "-started")) await new Promise(done => setTimeout(done, 10));
const configPath = join(configDir, "daemon.json");
const beforeFault = JSON.parse(readFileSync(configPath, "utf8"));
const identityAlreadyPersisted = Boolean(beforeFault.instances?.some(instance => instance.processIdentity));
rmSync(configPath);
mkdirSync(configPath);
writeFileSync(join(root, "managed-identity-persistence-fault.json"), JSON.stringify({ identityAlreadyPersisted }));
writeFileSync(gate + "-release", "fail the pending identity rename");
`,
		);
		chmodSync(executable, 0o755);
		try {
			const startup = await harness.restart({ skipBrowserProbe: true }).then(
				() => "ready",
				(cause: unknown) => String(cause),
			);
			await vi.waitFor(() => expect(existsSync(fault)).toBe(true), {
				timeout: 5000,
			});
			expect(JSON.parse(readFileSync(fault, "utf8"))).toEqual({
				identityAlreadyPersisted: false,
			});
			expect(
				statSync(join(harness.configDir, "daemon.json")).isDirectory(),
			).toBe(true);
			const record = JSON.parse(
				readFileSync(
					join(harness.configDir, "fake-opencode-pids.jsonl"),
					"utf8",
				).trim(),
			) as { pid: number; childPid: number; groupPid: number };
			for (const pid of [record.pid, record.childPid, record.groupPid])
				pids.add(pid);
			expect(harness.ownedOpenCodePids()).toEqual([]);
			expect(alive(record.childPid)).toBe(true);
			const root = harness.root;
			const cleanupStarted = Date.now();
			await harness.dispose();
			expect(harness.ownedOpenCodePids()).toEqual([]);
			expect(harness.proof()).toMatchObject({
				ownedOpenCodePids: [],
				managedCleanup: [],
				observedOpenCodePids: expect.arrayContaining([
					record.pid,
					record.childPid,
					record.groupPid,
				]),
				remainingObservedOpenCodePids: [],
			});
			expect([...pids].filter(alive)).toEqual([]);
			expect(existsSync(root)).toBe(false);
			scenarios.push({
				prePersistenceCleanup: true,
				startup,
				record,
				authenticatedMapEmpty: true,
				identityAlreadyPersisted: false,
				cleanupDurationMs: Date.now() - cleanupStarted,
				allTerminatedBeforeRemoval: true,
			});
		} finally {
			if (existsSync(harness.root)) writeFileSync(release, "cleanup");
		}
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
