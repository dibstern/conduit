import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { InstanceManager } from "../../../src/lib/instance/instance-manager.js";
import { stopManagedOpenCode } from "../../../src/lib/instance/managed-opencode-process.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: coupled process groups/pipes, lost credentials or dynamic port,
// stale/reused PID, dead server during downtime, permissive/wrong-auth health,
// persisted stale PID after shutdown, and a process ignoring SIGTERM.
describe("managed OpenCode survives server replacement", () => {
	let harness: ProcessHarness | undefined;
	const results: Array<Record<string, unknown>> = [];
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
		expect(instance).toBeDefined();
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
		return (await response.json()) as {
			pid: number;
			childPid: number;
			groupPid: number;
		};
	};

	afterEach(async (context) => {
		if (harness && context.task.result?.state === "fail") {
			const proof = harness.proof() as {
				logTail: string;
				generations: unknown;
			};
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-12-failure.json",
				JSON.stringify({
					logTail: proof.logTail,
					generations: proof.generations,
				}),
			);
		}
		await harness?.dispose();
		harness = undefined;
	});
	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/85kb-12-reuse.json",
			JSON.stringify(
				{
					ticket: "conduit-test-85kb.12",
					passed: results.length === 25,
					scenarios: results,
				},
				null,
				2,
			),
		);
	});

	it("reuses the authenticated PID and dynamic port after a server crash", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await vi.waitFor(() => expect(recorded().pid).toBeGreaterThan(0));
		const before = recorded();
		const processBefore = await health();
		expect(before.pid).toBe(processBefore.pid);
		expect(before.port).toBeGreaterThan(0);
		expect(before.version).toBe("fake-85kb.12");
		expect(before.env?.["OPENCODE_SERVER_PASSWORD"]).toBeTruthy();
		expect(() => process.kill(-processBefore.groupPid, 0)).not.toThrow();
		const logFile = join(
			harness.root,
			"config",
			"logs",
			"opencode-managed-test.log",
		);
		expect(readFileSync(logFile, "utf8")).toContain(
			"fake OpenCode stderr is captured",
		);
		expect(
			statSync(join(harness.root, "config", "daemon.json")).mode & 0o777,
		).toBe(0o600);
		expect(statSync(logFile).mode & 0o777).toBe(0o600);
		expect(
			(await fetch(`http://127.0.0.1:${before.port}/global/health`)).status,
		).toBe(401);
		await harness.kill();
		expect(alive(processBefore.pid)).toBe(true);
		await harness.restart();
		expect(await health()).toEqual(processBefore);
		expect(recorded()).toEqual(before);
		results.push({
			scenario: "crash-reuse",
			pidBefore: before.pid,
			pidAfter: recorded().pid,
			port: before.port,
			credentialsPersisted: true,
		});
	});

	it("keeps the instance through a graceful server restart", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await vi.waitFor(() => expect(recorded().pid).toBeGreaterThan(0));
		const before = await health();
		await harness.terminate();
		expect(harness.generations[0]?.exitCode).toBe(0);
		expect(alive(before.pid)).toBe(true);
		await harness.restart();
		expect(await health()).toEqual(before);
		results.push({
			scenario: "signal-reuse",
			pidBefore: before.pid,
			pidAfter: recorded().pid,
		});
	});

	it("respawns an instance killed while the server is down", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await vi.waitFor(() => expect(recorded().pid).toBeGreaterThan(0));
		const before = await health();
		await harness.kill();
		process.kill(before.pid, "SIGKILL");
		await vi.waitFor(() => expect(alive(before.pid)).toBe(false));
		await harness.restart();
		const after = await health();
		expect(after.pid).not.toBe(before.pid);
		expect(recorded().pid).toBe(after.pid);
		results.push({
			scenario: "dead-respawn",
			pidBefore: before.pid,
			pidAfter: after.pid,
		});
	});

	it("rejects an unrelated live PID and wrong-auth health without killing it", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await vi.waitFor(() => expect(recorded().pid).toBeGreaterThan(0));
		const before = await health();
		await harness.kill();
		process.kill(before.pid, "SIGKILL");
		await vi.waitFor(() => expect(alive(before.pid)).toBe(false));
		const strangerProcess = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ detached: true, stdio: "ignore" },
		);
		const strangerPid = strangerProcess.pid;
		if (strangerPid === undefined) throw new Error("Missing unrelated PID");
		const stranger = createServer((_request, response) =>
			response.writeHead(401).end(),
		);
		await new Promise<void>((done) => stranger.listen(0, "127.0.0.1", done));
		try {
			const address = stranger.address();
			if (!address || typeof address === "string")
				throw new Error("Missing port");
			const configFile = join(harness.root, "config", "daemon.json");
			const config = loadDaemonConfig(join(harness.root, "config"));
			if (!config) throw new Error("Missing config");
			config.instances = (config.instances ?? []).map((instance) =>
				instance.id === "managed-test"
					? { ...instance, pid: strangerPid, port: address.port }
					: instance,
			);
			writeFileSync(configFile, JSON.stringify(config));
			await harness.restart();
			const after = await health();
			expect(after.pid).not.toBe(strangerPid);
			expect(recorded().port).not.toBe(address.port);
			expect(alive(strangerPid)).toBe(true);
			results.push({
				scenario: "stale-pid-rejected",
				recordedPid: strangerPid,
				pidAfter: after.pid,
				unrelatedPidPreserved: true,
			});
		} finally {
			await new Promise<void>((done) => stranger.close(() => done()));
			await new Promise<void>((done) => {
				strangerProcess.once("exit", () => done());
				strangerProcess.kill("SIGTERM");
			});
		}
	});

	it("leaves no instance or descendant after explicit Shutdown RPC", async () => {
		harness = await ProcessHarness.start({
			managedOpenCode: true,
			ignoreOpenCodeSigterm: true,
		});
		await vi.waitFor(() => expect(recorded().pid).toBeGreaterThan(0));
		const before = await health();
		await harness.kill();
		await harness.restart();
		expect((await health()).pid).toBe(before.pid);
		await harness.shutdown();
		expect(harness.generations[1]?.exitCode).toBe(0);
		await vi.waitFor(
			() => {
				expect(alive(before.pid)).toBe(false);
				expect(alive(before.childPid)).toBe(false);
			},
			{ timeout: 5000 },
		);
		expect(recorded().pid).toBeUndefined();
		results.push({
			scenario: "explicit-shutdown",
			pid: before.pid,
			childPid: before.childPid,
			bothExited: true,
			recordCleared: true,
		});
	});

	it("terminates an adopted instance even when its health endpoint fails later", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		await harness.kill();
		await harness.restart();
		expect((await health()).pid).toBe(before.pid);
		const instance = recorded();
		const headers = {
			Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"]}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
		};
		const response = await fetch(
			`http://127.0.0.1:${instance.port}/test/fail-health`,
			{ method: "POST", headers },
		);
		expect(response.ok).toBe(true);
		expect(
			(
				await fetch(`http://127.0.0.1:${instance.port}/global/health`, {
					headers,
				})
			).status,
		).toBe(503);
		await harness.shutdown();
		await vi.waitFor(() => {
			expect(alive(before.pid)).toBe(false);
			expect(alive(before.childPid)).toBe(false);
		});
		expect(recorded().pid).toBeUndefined();
		results.push({
			scenario: "unhealthy-adopted-shutdown",
			pid: before.pid,
			bothExited: true,
			recordCleared: true,
		});
	});

	it("cleans up descendants when the legacy manager's process leader exits", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const manager = new InstanceManager({
			configDir: join(harness.root, "config"),
			healthPollIntervalMs: 50,
			maxRestartsPerWindow: 1,
		});
		const instance = manager.addInstance("legacy-test", {
			name: "Legacy process cleanup",
			managed: true,
			port: 0,
			env: {
				OPENCODE_SERVER_USERNAME: "legacy-user",
				OPENCODE_SERVER_PASSWORD: "legacy-test-password",
				CONDUIT_TEST_OPENCODE_LISTEN_DELAY_MS: "250",
				PATH: `${join(harness.root, "bin")}:${process.env["PATH"]}`,
				HOME: join(harness.root, "home"),
				CONDUIT_CONFIG_DIR: join(harness.root, "config"),
				XDG_DATA_HOME: join(harness.root, "data"),
			},
		});
		try {
			await manager.startInstance(instance.id);
			await vi.waitFor(() => expect(instance.status).toBe("healthy"), {
				timeout: 5000,
			});
			const response = await fetch(
				`http://127.0.0.1:${instance.port}/global/health`,
				{
					headers: {
						Authorization: `Basic ${Buffer.from("legacy-user:legacy-test-password").toString("base64")}`,
					},
				},
			);
			const before = (await response.json()) as {
				pid: number;
				childPid: number;
			};
			expect(alive(before.childPid)).toBe(true);
			process.kill(before.pid, "SIGTERM");
			await vi.waitFor(() => expect(instance.status).toBe("stopped"), {
				timeout: 5000,
			});
			await manager.drain();
			await vi.waitFor(() => expect(alive(before.childPid)).toBe(false));
			results.push({
				scenario: "legacy-leader-exit",
				pid: before.pid,
				childPid: before.childPid,
				bothExited: true,
			});
		} finally {
			await manager.drain();
		}
	});

	it("never adopts or signals an unrelated PID behind an authenticated server", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		await harness.kill();
		const stranger = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				detached: true,
				stdio: "ignore",
			},
		);
		const strangerPid = stranger.pid;
		if (strangerPid === undefined) throw new Error("Missing unrelated PID");
		try {
			const file = join(harness.root, "config", "daemon.json");
			const config = loadDaemonConfig(join(harness.root, "config"));
			if (!config) throw new Error("Missing config");
			config.instances = (config.instances ?? []).map((instance) =>
				instance.id === "managed-test"
					? { ...instance, pid: strangerPid }
					: instance,
			);
			writeFileSync(file, JSON.stringify(config));
			await harness.restart();
			const recovered = recorded();
			const after = await health();
			await harness.shutdown();
			expect(alive(strangerPid)).toBe(true);
			expect(recovered.pid).toBe(after.pid);
			expect(recovered.pid).not.toBe(strangerPid);
			expect(alive(before.pid)).toBe(false);
			results.push({
				scenario: "authenticated-port-pid-mismatch",
				unrelatedPidPreserved: true,
			});
		} finally {
			if (alive(strangerPid)) {
				await new Promise<void>((done) => {
					stranger.once("exit", () => done());
					stranger.kill("SIGTERM");
				});
			}
		}
	});

	it("drops invalid recovery metadata without losing PIN or other settings", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await harness.kill();
		const file = join(harness.root, "config", "daemon.json");
		const config = loadDaemonConfig(join(harness.root, "config"));
		if (!config) throw new Error("Missing config");
		const pinHash = "saved-pin-must-survive-invalid-process-metadata";
		writeFileSync(
			file,
			JSON.stringify({
				...config,
				pinHash,
				debug: true,
				dangerouslySkipPermissions: true,
				autoSettleAfterDays: 17,
				instances: config.instances?.map((instance) =>
					instance.id === "managed-test"
						? {
								...instance,
								pid: 0,
								version: 42,
								processIdentity: { pid: 0 },
								env: {
									...instance.env,
									OPENCODE_SERVER_PASSWORD: null,
									OPENCODE_SERVER_USERNAME: 42,
								},
							}
						: instance,
				),
			}),
		);
		expect(loadDaemonConfig(join(harness.root, "config"))?.pinHash).toBe(
			pinHash,
		);
		await harness.restart({ skipBrowserProbe: true });
		const saved = loadDaemonConfig(join(harness.root, "config"));
		expect(saved?.pinHash).toBe(pinHash);
		expect(saved?.debug).toBe(true);
		expect(saved?.dangerouslySkipPermissions).toBe(true);
		expect(saved?.autoSettleAfterDays).toBe(17);
		expect(recorded().pid).toBeGreaterThan(0);
		const port = harness.generations.at(-1)?.port;
		expect((await fetch(`http://127.0.0.1:${port}/api/projects`)).status).toBe(
			401,
		);
		results.push({
			scenario: "invalid-recovery-preserves-auth",
			pinPreserved: true,
			settingsPreserved: true,
		});
	});

	it("keeps managed credentials out of browser RPC and broadcasts", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const password = recorded().env?.["OPENCODE_SERVER_PASSWORD"];
		const token = recorded().processIdentity?.token;
		expect(password).toBeTruthy();
		expect(token).toBeTruthy();
		const browser = await harness.connect();
		const responses = [
			await browser.instances(),
			await browser.instanceStatus("managed-test"),
		];
		await harness.terminate();
		await harness.restart();
		const replacement = await harness.connect();
		responses.push(
			await replacement.instances(),
			await replacement.instanceStatus("managed-test"),
		);
		const messages = [
			...responses,
			...browser.frames.map((frame) => frame.message),
			...replacement.frames.map((frame) => frame.message),
		];
		for (const message of messages) {
			expect(JSON.stringify(message)).not.toContain(password);
			expect(JSON.stringify(message)).not.toContain(token);
			expect(JSON.stringify(message)).not.toContain("processIdentity");
			expect(JSON.stringify(message)).not.toContain("OPENCODE_SERVER_PASSWORD");
		}
		results.push({
			scenario: "backend-only-credentials",
			responsesAndBroadcastsChecked: messages.length,
		});
	});

	it("drops managed credentials and stops ownership when converting to Claude", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		const password = recorded().env?.["OPENCODE_SERVER_PASSWORD"];
		expect(password).toBeTruthy();
		const browser = await harness.connect();
		await browser.updateInstance("managed-test", {
			driver: "claude",
			env: { KEEP_ENV: "retained" },
		});
		await harness.terminate();
		await harness.restart();
		const replacement = await harness.connect();
		const instances = await replacement.instances();
		expect(JSON.stringify(instances)).not.toContain(password);
		expect(JSON.stringify(instances)).not.toContain("OPENCODE_SERVER_PASSWORD");
		expect(recorded().driver).toBe("claude");
		expect(recorded().env).toEqual({ KEEP_ENV: "retained" });
		expect(recorded().processIdentity).toBeUndefined();
		expect(
			readFileSync(join(harness.root, "config", "daemon.json"), "utf8"),
		).not.toContain(password);
		expect(alive(before.pid)).toBe(false);
		expect(alive(before.childPid)).toBe(false);
		expect(alive(before.groupPid)).toBe(false);
		results.push({
			scenario: "driver-conversion-credentials",
			credentialsRemoved: true,
			groupExited: true,
		});
	});

	it("spawns a second healthy managed process after browser StopInstance then StartInstance", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		const browser = await harness.connect();
		await browser.stopInstance("managed-test");
		expect(alive(before.pid)).toBe(false);
		expect(alive(before.childPid)).toBe(false);
		await Promise.all([
			browser.startInstance("managed-test"),
			browser.startInstance("managed-test"),
		]);
		await vi.waitFor(
			async () => {
				const status = await browser.instanceStatus("managed-test");
				expect(status.instance?.status).toBe("healthy");
			},
			{ timeout: 7000 },
		);
		const after = await health();
		expect(after.pid).not.toBe(before.pid);
		expect(
			readFileSync(
				join(harness.root, "config", "fake-opencode-pids.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n"),
		).toHaveLength(2);
		await harness.terminate();
		await harness.restart();
		expect((await health()).pid).toBe(after.pid);
		await harness.shutdown();
		expect(alive(after.pid)).toBe(false);
		expect(alive(after.childPid)).toBe(false);
		expect(alive(after.groupPid)).toBe(false);
		results.push({
			scenario: "browser-stop-start",
			pidBefore: before.pid,
			pidAfter: after.pid,
			spawns: 2,
			reusedAfterRestart: true,
			groupExited: true,
		});
	});

	it("respawns after its supervisor exits even if the recorded worker PID belongs to a stranger", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		await harness.kill();
		const instance = recorded();
		expect(await stopManagedOpenCode(instance)).toBe(true);
		const stranger = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{ stdio: "ignore" },
		);
		const strangerPid = stranger.pid;
		if (!strangerPid) throw new Error("Missing unrelated fixture PID");
		try {
			const configDir = join(harness.root, "config");
			const config = loadDaemonConfig(configDir);
			if (!config) throw new Error("Missing config");
			config.instances = (config.instances ?? []).map((instance) =>
				instance.id === "managed-test"
					? { ...instance, pid: strangerPid }
					: instance,
			);
			writeFileSync(join(configDir, "daemon.json"), JSON.stringify(config));
			await harness.restart();
			const browser = await harness.connect();
			expect(
				(await browser.instanceStatus("managed-test")).instance?.status,
			).toBe("healthy");
			const after = await health();
			expect(after.pid).not.toBe(before.pid);
			expect(after.pid).not.toBe(strangerPid);
			expect(alive(strangerPid)).toBe(true);
			await harness.shutdown();
			expect(alive(strangerPid)).toBe(true);
			results.push({
				scenario: "dead-supervisor-stale-worker",
				unrelatedPidPreserved: true,
				pidAfter: after.pid,
			});
		} finally {
			if (stranger.exitCode === null && stranger.signalCode === null) {
				await new Promise<void>((done) => {
					stranger.once("exit", () => done());
					stranger.kill("SIGTERM");
				});
			}
		}
	});

	it("cleans fixture ownership without signalling recycled IDs from its process ledger", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const instance = recorded();
		const before = await health();
		await harness.kill();
		const stranger = spawn(
			process.execPath,
			["-e", "process.on('message', () => process.send('alive'));"],
			{ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
		);
		const strangerPid = stranger.pid;
		if (!strangerPid) throw new Error("Missing unrelated fixture PID");
		try {
			const configDir = join(harness.root, "config");
			appendFileSync(
				join(configDir, "fake-opencode-pids.jsonl"),
				`${JSON.stringify({ pid: strangerPid, childPid: strangerPid, groupPid: strangerPid })}\n`,
			);
			const config = loadDaemonConfig(configDir);
			if (!config) throw new Error("Missing config");
			config.instances = (config.instances ?? []).map((instance) =>
				instance.processIdentity
					? {
							...instance,
							pid: strangerPid,
							processIdentity: {
								...instance.processIdentity,
								supervisorPid: strangerPid,
							},
						}
					: instance,
			);
			writeFileSync(join(configDir, "daemon.json"), JSON.stringify(config));
			await harness.dispose();
			await vi.waitFor(() => {
				expect(alive(before.pid)).toBe(false);
				expect(alive(before.childPid)).toBe(false);
				expect(alive(before.groupPid)).toBe(false);
			});
			await new Promise<void>((done, fail) => {
				const timeout = setTimeout(
					() => fail(new Error("Unrelated fixture stopped responding")),
					1000,
				);
				stranger.once("message", (message) => {
					clearTimeout(timeout);
					if (message === "alive") done();
					else fail(new Error("Unexpected unrelated fixture response"));
				});
				stranger.send("probe", (error) => {
					if (error) {
						clearTimeout(timeout);
						fail(error);
					}
				});
			});
			results.push({
				scenario: "identity-verified-fixture-cleanup",
				unrelatedPidPreserved: true,
				groupExited: true,
			});
		} finally {
			await stopManagedOpenCode(instance);
			if (stranger.exitCode === null && stranger.signalCode === null) {
				await new Promise<void>((done) => {
					stranger.once("exit", () => done());
					stranger.kill("SIGTERM");
				});
			}
		}
	});

	it("retains fixture cleanup ownership when its supervisor cannot authenticate and retries", async () => {
		harness = await ProcessHarness.start({
			managedOpenCode: true,
			pauseOpenCodeSupervisor: true,
		});
		const instance = recorded();
		const identity = instance.processIdentity;
		if (!identity || !instance.pid) throw new Error("Missing paused ownership");
		try {
			await expect(harness.dispose()).rejects.toThrow(
				"Cannot verify managed fixture cleanup",
			);
			expect(existsSync(join(harness.root, "config", "daemon.json"))).toBe(
				true,
			);
			expect(alive(identity.supervisorPid)).toBe(true);
			// This fixture pauses its own parent, so that live PID cannot be reused.
			process.kill(identity.supervisorPid, "SIGCONT");
			await harness.dispose();
			await vi.waitFor(() => {
				expect(alive(instance.pid ?? 0)).toBe(false);
				expect(alive(identity.supervisorPid)).toBe(false);
			});
			expect(existsSync(harness.root)).toBe(false);
			results.push({
				scenario: "fixture-cleanup-retry",
				ownershipRetained: true,
				groupExited: true,
			});
		} finally {
			if (alive(identity.supervisorPid)) {
				process.kill(identity.supervisorPid, "SIGCONT");
				await stopManagedOpenCode(instance);
			}
		}
	});

	it("prefetches existing sessions using backend credentials for a managed instance", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await harness.kill();
		const projectDir = join(harness.root, "prefetch-project");
		mkdirSync(projectDir);
		const configDir = join(harness.root, "config");
		const config = loadDaemonConfig(configDir);
		if (!config) throw new Error("Missing config");
		config.projects.push({
			path: projectDir,
			folders: [projectDir],
			slug: "prefetch-opencode",
			instanceId: "managed-test",
			addedAt: Date.now(),
		});
		writeFileSync(join(configDir, "daemon.json"), JSON.stringify(config));
		writeFileSync(
			join(configDir, "fake-opencode-sessions.json"),
			JSON.stringify([
				{
					id: "existing-prefetch-session",
					slug: "existing-session",
					version: "1.18.34",
					projectID: "global",
					title: "Existing session",
					directory: realpathSync(projectDir),
					time: { created: Date.now(), updated: Date.now() },
				},
			]),
		);
		await harness.restart();
		const browser = await harness.connect();
		await vi.waitFor(
			async () =>
				expect((await browser.daemonStatus()).sessionCount).toBeGreaterThan(0),
			{ timeout: 5000 },
		);
		const requests = readFileSync(
			join(configDir, "fake-opencode-session-requests.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as { authenticated: boolean; directory: string },
			);
		expect(
			requests.some(
				(request) =>
					request.directory === realpathSync(projectDir) &&
					request.authenticated,
			),
		).toBe(true);
		results.push({
			scenario: "managed-session-prefetch",
			sessionCount: (await browser.daemonStatus()).sessionCount,
			authenticated: true,
		});
	});

	it("terminates a verified unhealthy instance before replacing its recovery record", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		const instance = recorded();
		await fetch(`http://127.0.0.1:${instance.port}/test/fail-health`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"]}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
			},
		});
		await harness.kill();
		await harness.restart();
		const after = await health();
		expect(after.pid).not.toBe(before.pid);
		await vi.waitFor(() => {
			expect(alive(before.pid)).toBe(false);
			expect(alive(before.childPid)).toBe(false);
		});
		results.push({
			scenario: "unhealthy-replacement-cleanup",
			oldGroupExited: true,
		});
	});

	it("stops a removed managed group before server-only teardown", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		const browser = await harness.connect();
		await browser.removeInstance("managed-test");
		await harness.terminate();
		await vi.waitFor(() => {
			expect(alive(before.pid)).toBe(false);
			expect(alive(before.childPid)).toBe(false);
		});
		expect(
			loadDaemonConfig(join(harness.root, "config"))?.instances?.some(
				(instance) => instance.id === "managed-test",
			),
		).toBe(false);
		results.push({
			scenario: "removed-instance-cleanup",
			bothExited: true,
			recordRemoved: true,
		});
	});

	it("reserves legacy recovery before concurrent start calls can spawn", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const manager = new InstanceManager({
			configDir: join(harness.root, "config"),
			healthPollIntervalMs: 50,
			maxRestartsPerWindow: 1,
		});
		const instance = manager.addInstance("concurrent-test", {
			name: "Concurrent recovery",
			managed: true,
			port: 0,
			pid: process.pid,
			env: {
				PATH: `${join(harness.root, "bin")}:${process.env["PATH"]}`,
				HOME: join(harness.root, "home"),
				CONDUIT_CONFIG_DIR: join(harness.root, "config"),
				XDG_DATA_HOME: join(harness.root, "data"),
			},
		});
		const pidsFile = join(harness.root, "config", "fake-opencode-pids.jsonl");
		const before = readFileSync(pidsFile, "utf8").trim().split("\n").length;
		try {
			await Promise.all([
				manager.startInstance(instance.id),
				manager.startInstance(instance.id),
			]);
			await vi.waitFor(() => expect(instance.status).toBe("healthy"), {
				timeout: 5000,
			});
			expect(readFileSync(pidsFile, "utf8").trim().split("\n")).toHaveLength(
				before + 1,
			);
			results.push({ scenario: "concurrent-recovery", childrenSpawned: 1 });
		} finally {
			await manager.drain();
		}
	});

	it("requires the verified generation and process identity before every stop", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const instance = recorded();
		const before = await health();
		const identity = instance.processIdentity;
		if (!identity) throw new Error("Missing private process identity");
		expect(identity.supervisorPid).toBe(before.groupPid);
		expect(
			await stopManagedOpenCode({
				pid: before.pid,
				processIdentity: { ...identity, token: "0".repeat(64) },
			}),
		).toBe(false);
		expect(
			await stopManagedOpenCode({
				pid: before.pid,
				processIdentity: { ...identity, supervisorPid: process.pid },
			}),
		).toBe(false);
		expect(
			await stopManagedOpenCode({
				pid: process.pid,
				processIdentity: identity,
			}),
		).toBe(false);
		expect(await health()).toEqual(before);
		expect(alive(before.childPid)).toBe(true);
		await harness.shutdown();
		expect(alive(before.pid)).toBe(false);
		expect(alive(before.groupPid)).toBe(false);
		results.push({
			scenario: "verified-stop-generation",
			rejectedUnverifiedStops: 3,
			supervisorExited: true,
		});
	});

	it("retains a live recovery handle when control authentication cannot be verified", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		const identity = recorded().processIdentity;
		if (!identity) throw new Error("Missing private process identity");
		await harness.kill();
		const configDir = join(harness.root, "config");
		const config = loadDaemonConfig(configDir);
		if (!config) throw new Error("Missing config");
		config.instances = (config.instances ?? []).map((instance) =>
			instance.id === "managed-test"
				? {
						...instance,
						processIdentity: { ...identity, token: "0".repeat(64) },
					}
				: instance,
		);
		writeFileSync(join(configDir, "daemon.json"), JSON.stringify(config));
		await harness.restart();
		expect(recorded().pid).toBe(before.pid);
		expect(await health()).toEqual(before);
		const browser = await harness.connect();
		await expect(browser.removeInstance("managed-test")).rejects.toThrow();
		expect(recorded().processIdentity?.supervisorPid).toBe(before.groupPid);
		expect(alive(before.pid)).toBe(true);
		await harness.terminate();
		const retained = loadDaemonConfig(configDir);
		if (!retained) throw new Error("Missing retained config");
		retained.instances = (retained.instances ?? []).map((instance) =>
			instance.id === "managed-test"
				? { ...instance, processIdentity: identity }
				: instance,
		);
		writeFileSync(join(configDir, "daemon.json"), JSON.stringify(retained));
		await harness.restart();
		expect(await health()).toEqual(before);
		await harness.shutdown();
		expect(alive(before.pid)).toBe(false);
		expect(alive(before.childPid)).toBe(false);
		results.push({
			scenario: "unverifiable-control-retains-ownership",
			pid: before.pid,
			removalRefused: true,
			cleanupAfterProofRestored: true,
		});
	});

	it("identifies and reuses the listener behind an npm-style OpenCode launcher", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const before = await health();
		await harness.kill();
		process.kill(before.pid, "SIGKILL");
		await vi.waitFor(() => expect(alive(before.pid)).toBe(false));
		const native = join(harness.root, "bin", "native-opencode");
		writeFileSync(native, readFileSync(join(harness.root, "bin", "opencode")), {
			mode: 0o755,
		});
		writeFileSync(
			join(harness.root, "bin", "opencode"),
			`#!/usr/bin/env node\nimport { spawn } from "node:child_process";\nconst child = spawn(process.execPath, [${JSON.stringify(native)}, ...process.argv.slice(2)], { stdio: "inherit" });\nchild.once("exit", code => process.exit(code ?? 1));\n`,
		);
		await harness.restart();
		const listener = await health();
		expect(recorded().pid).toBe(listener.pid);
		await harness.kill();
		await harness.restart();
		expect(await health()).toEqual(listener);
		const instance = recorded();
		await fetch(`http://127.0.0.1:${instance.port}/test/close-listener`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from(`${instance.env?.["OPENCODE_SERVER_USERNAME"]}:${instance.env?.["OPENCODE_SERVER_PASSWORD"]}`).toString("base64")}`,
			},
		});
		await vi.waitFor(async () => {
			const listening = await fetch(
				`http://127.0.0.1:${instance.port}/global/health`,
				{ signal: AbortSignal.timeout(500) },
			).then(
				() => true,
				() => false,
			);
			expect(listening).toBe(false);
		});
		expect(alive(listener.pid)).toBe(true);
		await harness.shutdown();
		await vi.waitFor(() => {
			expect(alive(listener.pid)).toBe(false);
			expect(alive(listener.childPid)).toBe(false);
			expect(alive(listener.groupPid)).toBe(false);
		});
		results.push({
			scenario: "launcher-listener-reuse",
			pidBefore: listener.pid,
			pidAfter: listener.pid,
			listenerClosedBeforeStop: true,
			groupExited: true,
		});
	});

	it("cleans an uncommitted spawn if the server crashes before saving its identity", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		const instance = recorded();
		const helperUrl = new URL(
			"../../../src/lib/instance/managed-opencode-process.ts",
			import.meta.url,
		).href;
		const driver = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				"--input-type=module",
				"-e",
				`const { availableOpenCodePort, spawnManagedOpenCode, probeOpenCodeHealth } = await import(${JSON.stringify(helperUrl)});
const port = await availableOpenCodePort();
const spawned = await spawnManagedOpenCode("uncommitted-test", port, ${JSON.stringify(instance.env)}, ${JSON.stringify(join(harness.root, "config"))});
while (!(await probeOpenCodeHealth(port, ${JSON.stringify(instance.env)}))) await new Promise(done => setTimeout(done, 20));
process.send({ pid: spawned.pid, groupPid: spawned.processIdentity.supervisorPid });
process.kill(process.pid, "SIGKILL");`,
			],
			{
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: {
					...process.env,
					HOME: join(harness.root, "home"),
					PATH: `${join(harness.root, "bin")}:${process.env["PATH"]}`,
					CONDUIT_CONFIG_DIR: join(harness.root, "config"),
					XDG_CONFIG_HOME: join(harness.root, "xdg"),
					XDG_DATA_HOME: join(harness.root, "data"),
				},
			},
		);
		let driverErrors = "";
		driver.stderr?.on("data", (chunk: Buffer) => {
			driverErrors += chunk.toString();
		});
		try {
			const spawned = await new Promise<{ pid: number; groupPid: number }>(
				(resolve, reject) => {
					driver.once("message", (message) =>
						resolve(message as { pid: number; groupPid: number }),
					);
					driver.once("error", reject);
					driver.once("exit", () => reject(new Error(driverErrors)));
				},
			);
			const ledger = readFileSync(
				join(harness.root, "config", "fake-opencode-pids.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { pid: number; childPid: number });
			const childPid = ledger.find(
				(entry) => entry.pid === spawned.pid,
			)?.childPid;
			expect(childPid).toBeGreaterThan(0);
			await vi.waitFor(
				() => {
					expect(alive(spawned.pid)).toBe(false);
					expect(alive(spawned.groupPid)).toBe(false);
					expect(alive(childPid ?? 0)).toBe(false);
				},
				{ timeout: 5000 },
			);
			results.push({
				scenario: "pre-persistence-crash-cleanup",
				groupExited: true,
			});
		} finally {
			if (driver.exitCode === null && driver.signalCode === null)
				driver.kill("SIGKILL");
		}
	});

	it("retries cleanup on explicit shutdown after failed startup control recovers", async () => {
		harness = await ProcessHarness.start({
			managedOpenCode: true,
			pauseOpenCodeSupervisor: true,
		});
		const instance = recorded();
		const identity = instance.processIdentity;
		if (!identity || !instance.pid)
			throw new Error("Lost failed-start ownership");
		expect(alive(instance.pid)).toBe(true);
		// The fixture has paused its own live parent; its PID cannot be reused.
		process.kill(identity.supervisorPid, "SIGCONT");
		await harness.shutdown();
		await vi.waitFor(() => {
			expect(alive(instance.pid ?? 0)).toBe(false);
			expect(alive(identity.supervisorPid)).toBe(false);
		});
		expect(recorded().pid).toBeUndefined();
		results.push({ scenario: "failed-start-cleanup-retry", groupExited: true });
	});

	it("cleans up a failed spawn and permits a subsequent start", async () => {
		harness = await ProcessHarness.start({ managedOpenCode: true });
		await vi.waitFor(() => expect(recorded().pid).toBeGreaterThan(0));
		const before = await health();
		await harness.kill();
		process.kill(-before.groupPid, "SIGKILL");
		await vi.waitFor(() => expect(alive(before.pid)).toBe(false));
		const executable = join(harness.root, "bin", "opencode");
		writeFileSync(executable, "#!/usr/bin/env node\nprocess.exit(1);\n");
		await harness.restart();
		await vi.waitFor(() => expect(recorded().pid).toBeUndefined());
		await harness.kill();
		writeFileSync(
			executable,
			readFileSync(
				fileURLToPath(
					new URL("../../helpers/fake-opencode-process.mjs", import.meta.url),
				),
			),
		);
		await harness.restart();
		const after = await health();
		expect(after.pid).not.toBe(before.pid);
		results.push({
			scenario: "failed-spawn-recovery",
			pidBefore: before.pid,
			pidAfter: after.pid,
		});
	});
});
