import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as nodePty from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyHostClient as HostClient } from "../../../src/lib/terminal/pty-host-client.js";
import { isRecord } from "../../../src/lib/utils.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

const DIST = fileURLToPath(new URL("../../../dist/", import.meta.url));
const { PtyHostClient, restartPtyHost, stopPtyHost } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-client.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-client.js");
const { PTY_SCROLLBACK_BYTES, ptyHostSocketPath } = (await import(
	pathToFileURL(join(DIST, "src/lib/terminal/pty-host-protocol.js")).href
)) as typeof import("../../../src/lib/terminal/pty-host-protocol.js");
const { BUILD_ID } = (await import(
	pathToFileURL(join(DIST, "src/lib/build-id.js")).href
)) as typeof import("../../../src/lib/build-id.js");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// The complete marker must only appear in shell output, never in echoed input.
function printMarker(marker: string): string {
	return `printf '%s%s\\n' ${shellQuote(marker.slice(0, 4))} ${shellQuote(marker.slice(4))}`;
}

function terminalOutput(
	browser: ProcessBrowser,
	ptyId: string,
	cursor = 0,
): string {
	return browser.frames
		.slice(cursor)
		.filter(
			({ message }) =>
				message["type"] === "pty_output" && message["ptyId"] === ptyId,
		)
		.map(({ message }) => String(message["data"]))
		.join("");
}

async function waitForOutput(
	browser: ProcessBrowser,
	ptyId: string,
	marker: string,
	cursor = 0,
): Promise<string> {
	await browser.waitFor(
		(message) =>
			message["type"] === "pty_output" &&
			message["ptyId"] === ptyId &&
			terminalOutput(browser, ptyId, cursor).includes(marker),
		cursor,
	);
	return terminalOutput(browser, ptyId, cursor);
}

describe("PTY host process survival", () => {
	let harness: ProcessHarness | undefined;
	const clients: HostClient[] = [];
	const fixtures: ChildProcess[] = [];
	let evidence: Record<string, unknown> = {};

	afterEach(async (context) => {
		for (const client of clients.splice(0)) client.disconnect();
		if (!harness) return;
		try {
			await harness.dispose();
		} finally {
			for (const fixture of fixtures.splice(0)) {
				if (fixture.exitCode === null && fixture.signalCode === null)
					fixture.kill("SIGKILL");
			}
			const proofDir = evidence["secondPass"]
				? "test-results/85kb-11/second-pass"
				: "test-results/85kb-11";
			mkdirSync(proofDir, { recursive: true });
			writeFileSync(
				`${proofDir}/${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(
					{
						test: context.task.name,
						builtDist: DIST,
						serverBuildId: BUILD_ID,
						assertionsCompleted: Object.keys(evidence).length > 0,
						...evidence,
						harness: harness.proof(),
					},
					null,
					2,
				),
			);
			harness = undefined;
			evidence = {};
		}
	});

	async function connect(buildId?: string): Promise<HostClient> {
		if (!harness) throw new Error("Harness has not started");
		const client = await PtyHostClient.connect({
			configDir: harness.configDir,
			...(buildId ? { buildId } : {}),
		});
		clients.push(client);
		return client;
	}

	function spawnHostFixture(buildId: string, idleTimeoutMs?: string) {
		if (!harness) throw new Error("Harness has not started");
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
				fileURLToPath(
					new URL("../../helpers/pty-host-fixture.ts", import.meta.url),
				),
				harness.root,
				DIST,
				buildId,
			],
			{
				cwd: harness.projectDir,
				env: {
					PATH: process.env["PATH"] ?? "",
					HOME: join(harness.root, "home"),
					SHELL: "/bin/sh",
					CONDUIT_CONFIG_DIR: harness.configDir,
					...(idleTimeoutMs === undefined
						? {}
						: { CONDUIT_PTY_HOST_IDLE_TIMEOUT_MS: idleTimeoutMs }),
				},
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		fixtures.push(child);
		child.stdout?.resume();
		return child;
	}

	async function oldHostFixture(
		buildId = "85kb-idle-old",
		idleTimeoutMs?: number,
	): Promise<HostClient> {
		if (!harness) throw new Error("Harness has not started");
		await stopPtyHost({ configDir: harness.configDir, force: true });
		const child = spawnHostFixture(
			buildId,
			idleTimeoutMs === undefined ? undefined : String(idleTimeoutMs),
		);
		let logs = "";
		child.stderr?.on("data", (data: Buffer) => {
			logs = (logs + data.toString()).slice(-2000);
		});
		let connected: HostClient | undefined;
		const configDir = harness.configDir;
		await vi.waitFor(
			async () => {
				if (child.exitCode !== null || child.signalCode !== null)
					throw new Error(`Old host fixture exited before ready: ${logs}`);
				connected = await PtyHostClient.connect({
					configDir,
					buildId,
					start: false,
				});
			},
			{ timeout: 15_000, interval: 30 },
		);
		if (!connected) throw new Error("Old host fixture did not connect");
		clients.push(connected);
		return connected;
	}

	function sentinelProcess(): ChildProcess & { pid: number } {
		if (!harness) throw new Error("Harness has not started");
		const child = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				cwd: harness.projectDir,
				env: { HOME: join(harness.root, "home"), SHELL: "/bin/sh" },
				stdio: "ignore",
			},
		);
		fixtures.push(child);
		if (!child.pid) throw new Error("Sentinel process did not spawn");
		return child as ChildProcess & { pid: number };
	}

	async function controlProtocolFixture(
		configDir: string,
		advertisedPid: number,
		changedFraming = false,
	) {
		const helloVersions: number[] = [];
		const stops: Array<{ version: number; force: unknown }> = [];
		const sockets = new Set<Socket>();
		let closing: Promise<void> | undefined;
		const beginClose = () => {
			closing ??= new Promise<void>((done) => server.close(() => done()));
			return closing;
		};
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			let buffer = "";
			let version = 0;
			socket.on("data", (data: Buffer) => {
				buffer += data.toString();
				for (
					let newline = buffer.indexOf("\n");
					newline >= 0;
					newline = buffer.indexOf("\n")
				) {
					const message: unknown = JSON.parse(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					if (!isRecord(message)) {
						socket.destroy();
						return;
					}
					if (message["type"] === "hello") {
						version = Number(message["protocolVersion"]);
						helloVersions.push(version);
						const hello = changedFraming
							? { kind: "hello", protocol: 99, pid: advertisedPid }
							: {
									type: "hello",
									protocolVersion: 99,
									buildId: "control-fixture",
									pid: advertisedPid,
									openTerminals: 1,
								};
						socket.write(`${JSON.stringify(hello)}\n`);
					} else if (message["type"] === "stop") {
						stops.push({ version, force: message["force"] });
						if (version !== 99 || message["force"] !== true) {
							socket.write(
								`${JSON.stringify({ type: "stopped", requestId: message["requestId"], stopped: false })}\n`,
							);
							continue;
						}
						socket.end(
							`${JSON.stringify({ type: "stopped", requestId: message["requestId"], stopped: true })}\n`,
						);
						void beginClose();
					}
				}
			});
		});
		await new Promise<void>((done, fail) => {
			server.once("error", fail);
			server.listen(ptyHostSocketPath(configDir), done);
		});
		return {
			helloVersions,
			stops,
			close: async () => {
				for (const socket of sockets) socket.destroy();
				await beginClose();
			},
		};
	}

	it("closes a hosted shell before any discovery after server restart", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const browser = await harness.connect();
		const pty = await browser.createPty();
		const host = await connect();
		const hostPid = host.hello.pid;
		const marker = `85kb-undiscovered-close-${randomUUID()}`;
		browser.inputPty(pty.id, `stty -echo; ${printMarker(marker)}\n`);
		await waitForOutput(browser, pty.id, marker);
		await harness.kill();
		await harness.restart({ skipBrowserProbe: true });
		evidence = {
			secondPass: true,
			assertionsCompleted: false,
			rpcOnly: true,
			discoveryBeforeClose: false,
			hostPid,
			shellPid: pty.pid,
			ptyId: pty.id,
		};
		let closeError: string | undefined;
		try {
			await harness.closePtyWithoutBrowser(pty.id);
		} catch (error) {
			closeError = String(error);
		}
		const listedIds = (await host.list(harness.projectDir)).map(
			({ pty }) => pty.id,
		);
		evidence["closeError"] = closeError ?? null;
		evidence["listedIdsAfterClose"] = listedIds;
		evidence["shellAliveAfterClose"] = alive(pty.pid);
		expect(closeError).toBeUndefined();
		const projectDir = harness.projectDir;
		await vi.waitFor(async () => {
			const ids = (await host.list(projectDir)).map(({ pty }) => pty.id);
			evidence["listedIdsAfterClose"] = ids;
			expect(ids).not.toContain(pty.id);
		});
		await vi.waitFor(() => expect(alive(pty.pid)).toBe(false));
		expect(alive(hostPid)).toBe(true);
		evidence["shellAliveAfterClose"] = false;
		evidence["assertionsCompleted"] = true;
	});

	it("expires an idle host after startup without any socket peers", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const graceMs = 350;
		const child = spawnHostFixture(BUILD_ID, String(graceMs));
		evidence = {
			secondPass: true,
			assertionsCompleted: false,
			graceMs,
			hostPid: child.pid,
			connectedPeers: 0,
			liveTerminals: 0,
		};
		let startupOutput = "";
		child.stdout?.on("data", (data: Buffer) => {
			startupOutput = (startupOutput + data.toString()).slice(-2000);
			evidence["hostStartupOutput"] = startupOutput;
		});
		await vi.waitFor(
			() =>
				expect(startupOutput).toContain(
					`PTY host pid=${child.pid} build=${BUILD_ID} socket=`,
				),
			{ timeout: 15_000, interval: 20 },
		);
		await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2000 });
		evidence["hostExited"] = true;
		evidence["socketRemoved"] = !existsSync(
			ptyHostSocketPath(harness.configDir),
		);
		expect(evidence["socketRemoved"]).toBe(true);
		evidence["assertionsCompleted"] = true;
	});

	it("cancels idle expiry for an unnegotiated peer and restarts grace on disconnect", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const graceMs = 250;
		const host = await oldHostFixture(BUILD_ID, graceMs);
		const child = fixtures.at(-1);
		if (!child) throw new Error("Host fixture was not spawned");
		const hostPid = host.hello.pid;
		host.disconnect();
		await new Promise((done) => setTimeout(done, 70));
		const peer = createConnection(ptyHostSocketPath(harness.configDir));
		try {
			await new Promise<void>((done, fail) => {
				peer.once("connect", done);
				peer.once("error", fail);
			});
			await new Promise((done) => setTimeout(done, 2 * graceMs));
			evidence = {
				secondPass: true,
				assertionsCompleted: false,
				graceMs,
				hostPid,
				unnegotiatedPeerPreservedHost: alive(hostPid),
			};
			expect(alive(hostPid)).toBe(true);
			peer.end();
			const disconnectedAt = Date.now();
			await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2000 });
			evidence["idleExitDelayMs"] = Date.now() - disconnectedAt;
			expect(Number(evidence["idleExitDelayMs"])).toBeGreaterThanOrEqual(
				graceMs - 30,
			);
			evidence["assertionsCompleted"] = true;
		} finally {
			peer.destroy();
		}
	});

	it.each([
		"natural exit",
		"explicit close",
	] as const)("keeps live shells without peers and expires after %s and last disconnect", async (finish) => {
		harness = await ProcessHarness.start({ dist: DIST });
		const graceMs = 200;
		const host = await oldHostFixture(BUILD_ID, graceMs);
		const child = fixtures.at(-1);
		if (!child) throw new Error("Host fixture was not spawned");
		const session = await host.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		let output = "";
		session.onData((data) => {
			output += data;
		});
		const marker = `85kb-live-idle-${randomUUID()}`;
		session.upstream.send(`stty -echo; ${printMarker(marker)}\n`);
		await vi.waitFor(() => expect(output).toContain(marker));
		host.disconnect();
		await new Promise((done) => setTimeout(done, 3 * graceMs));
		evidence = {
			secondPass: true,
			assertionsCompleted: false,
			graceMs,
			finish,
			hostPid: host.hello.pid,
			shellPid: session.pty.pid,
			liveHostSurvivedWithoutPeers: alive(host.hello.pid),
			liveShellSurvivedWithoutPeers: alive(session.pty.pid),
		};
		expect(alive(host.hello.pid)).toBe(true);
		expect(alive(session.pty.pid)).toBe(true);
		const reconnected = await connect();
		expect(reconnected.hello.pid).toBe(host.hello.pid);
		const restored = await reconnected.attach(
			session.pty.id,
			harness.projectDir,
		);
		let replay = "";
		restored.onData((data) => {
			replay += data;
		});
		expect(replay).toContain(marker);
		if (finish === "natural exit") restored.upstream.send("exit\n");
		else restored.upstream.close();
		await vi.waitFor(() => expect(alive(session.pty.pid)).toBe(false));
		const records = await reconnected.list(harness.projectDir);
		if (finish === "natural exit") expect(records[0]?.exitCode).toBe(0);
		else expect(records).toHaveLength(0);
		evidence["savedExitedRecords"] = records.length;
		await new Promise((done) => setTimeout(done, 2 * graceMs));
		expect(alive(host.hello.pid)).toBe(true);
		reconnected.disconnect();
		await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2000 });
		evidence["hostExitedAfterLastPeer"] = true;
		evidence["assertionsCompleted"] = true;
	});

	it("expires after a shell exits naturally while no host peers are connected", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const graceMs = 200;
		const host = await oldHostFixture(BUILD_ID, graceMs);
		const child = fixtures.at(-1);
		if (!child) throw new Error("Host fixture was not spawned");
		const trigger = join(harness.root, "exit-without-peers");
		const session = await host.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		let output = "";
		session.onData((data) => {
			output += data;
		});
		const marker = `85kb-no-peers-exit-${randomUUID()}`;
		session.upstream.send(
			`stty -echo; ${printMarker(marker)}; while [ ! -f ${shellQuote(trigger)} ]; do sleep 0.02; done; exit\n`,
		);
		await vi.waitFor(() => expect(output).toContain(marker));
		host.disconnect();
		await new Promise((done) => setTimeout(done, 3 * graceMs));
		evidence = {
			secondPass: true,
			assertionsCompleted: false,
			graceMs,
			hostPid: host.hello.pid,
			shellPid: session.pty.pid,
			liveShellSurvivedWithoutPeers: alive(session.pty.pid),
			noPeersAtNaturalExit: true,
		};
		expect(alive(session.pty.pid)).toBe(true);
		writeFileSync(trigger, "exit");
		await vi.waitFor(() => expect(alive(session.pty.pid)).toBe(false));
		await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2000 });
		evidence["hostExited"] = true;
		evidence["assertionsCompleted"] = true;
	});

	it.each([
		"parent disconnect",
		"SIGTERM",
		"SIGINT",
	] as const)("tears down only its owned fixture host and shell after %s", async (signal) => {
		harness = await ProcessHarness.start({ dist: DIST });
		const host = await oldHostFixture(BUILD_ID);
		const child = fixtures.at(-1);
		if (!child) throw new Error("Host fixture was not spawned");
		const session = await host.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		evidence = {
			secondPass: true,
			assertionsCompleted: false,
			signal,
			hostPid: host.hello.pid,
			shellPid: session.pty.pid,
		};
		if (signal === "parent disconnect") child.disconnect();
		else child.kill(signal);
		await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 2000 });
		expect(alive(session.pty.pid)).toBe(false);
		expect(alive(host.hello.pid)).toBe(false);
		expect(existsSync(ptyHostSocketPath(harness.configDir))).toBe(false);
		evidence["assertionsCompleted"] = true;
	});

	it.each([
		"0",
		"-1",
		"1.5",
		"Infinity",
		"2147483648",
	])("rejects invalid idle grace %s before creating host IPC", async (idleTimeout) => {
		harness = await ProcessHarness.start({ dist: DIST });
		const child = spawnHostFixture(BUILD_ID, idleTimeout);
		let error = "";
		child.stderr?.on("data", (data: Buffer) => {
			error = (error + data.toString()).slice(-2000);
		});
		evidence = {
			secondPass: true,
			assertionsCompleted: false,
			idleTimeout,
			hostPid: child.pid,
		};
		await vi.waitFor(() => expect(child.exitCode).not.toBeNull(), {
			timeout: 2000,
		});
		expect(child.exitCode).not.toBe(0);
		expect(error).toContain("CONDUIT_PTY_HOST_IDLE_TIMEOUT_MS");
		expect(existsSync(ptyHostSocketPath(harness.configDir))).toBe(false);
		evidence["validationError"] = error;
		evidence["assertionsCompleted"] = true;
	});

	it.each([
		"SIGKILL",
		"SIGTERM",
	] as const)("keeps shell PID and replays disconnected output once after %s", async (stop) => {
		harness = await ProcessHarness.start({ dist: DIST });
		const browser = await harness.connect();
		const pty = await browser.createPty();
		const host = await connect();
		const hostPid = host.hello.pid;
		const original = `85kb-original-${randomUUID()}`;
		const whileDown = `85kb-disconnected-${randomUUID()}`;
		const armed = `85kb-armed-${randomUUID()}`;
		const continued = `85kb-live-${randomUUID()}`;
		const trigger = join(harness.root, "emit-while-server-down");
		const finished = join(harness.root, "disconnected-output-written");
		browser.inputPty(pty.id, `stty -echo; ${printMarker(original)}\n`);
		await waitForOutput(browser, pty.id, original);
		browser.inputPty(
			pty.id,
			`(while [ ! -f ${shellQuote(trigger)} ]; do sleep 0.02; done; ${printMarker(whileDown)}; printf done > ${shellQuote(finished)}) &\n${printMarker(armed)}\n`,
		);
		await waitForOutput(browser, pty.id, armed);
		if (stop === "SIGKILL") await harness.kill();
		else await harness.terminate();
		if (stop === "SIGKILL")
			expect(harness.generations[0]?.signal).toBe("SIGKILL");
		else {
			expect(harness.generations[0]?.exitCode).toBe(0);
			expect(harness.generations[0]?.signal).toBeNull();
		}
		expect(alive(pty.pid)).toBe(true);
		expect(alive(hostPid)).toBe(true);
		writeFileSync(trigger, "go");
		await vi.waitFor(() => expect(existsSync(finished)).toBe(true));
		await harness.restart();
		const reconnected = await harness.connect();
		const ptys = await reconnected.listPtys();
		expect(ptys.find(({ id }) => id === pty.id)).toMatchObject({
			pid: pty.pid,
			status: "running",
		});
		await waitForOutput(reconnected, pty.id, whileDown);
		expect(alive(pty.pid)).toBe(true);
		expect((await connect()).hello.pid).toBe(hostPid);
		const cursor = reconnected.frames.length;
		await reconnected.resizePty(pty.id, 101, 37);
		reconnected.inputPty(
			pty.id,
			`printf '%s%s:%s\\n' '85kb' '-shell-pid' "$$"; stty size; ${printMarker(continued)}\n`,
		);
		const live = await waitForOutput(reconnected, pty.id, continued, cursor);
		expect(live).toContain(`85kb-shell-pid:${pty.pid}`);
		expect(live).toMatch(/(?:^|\r?\n)37 101\r?\n/);
		const replay = terminalOutput(reconnected, pty.id);
		expect(replay.split(original)).toHaveLength(2);
		expect(replay.split(whileDown)).toHaveLength(2);
		expect(replay.indexOf(original)).toBeLessThan(replay.indexOf(whileDown));
		expect(replay.indexOf(whileDown)).toBeLessThan(replay.indexOf(continued));
		await reconnected.closePty(pty.id);
		await vi.waitFor(() => expect(alive(pty.pid)).toBe(false));
		expect((await reconnected.listPtys()).some(({ id }) => id === pty.id)).toBe(
			false,
		);
		evidence = {
			stop,
			hostPid,
			shellPid: pty.pid,
			ptyId: pty.id,
			markers: { original, whileDown, continued },
			replay,
		};
	}, 60_000);

	it("keeps the old host on build mismatch while a terminal is open", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const old = await connect();
		const session = await old.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home"), SHELL: "/bin/sh" },
		});
		old.disconnect();
		const upgradedServer = await connect("85kb-host-new");
		expect(upgradedServer.hello).toMatchObject({
			pid: old.hello.pid,
			buildId: old.hello.buildId,
			openTerminals: 1,
		});
		expect(alive(session.pty.pid)).toBe(true);
		const browser = await harness.connect();
		expect(await browser.listPtys()).toContainEqual(session.pty);
		const marker = `85kb-old-host-live-${randomUUID()}`;
		browser.inputPty(session.pty.id, `${printMarker(marker)}\n`);
		await waitForOutput(browser, session.pty.id, marker);
		evidence = {
			oldHost: old.hello,
			connectedHost: upgradedServer.hello,
			shellPid: session.pty.pid,
			marker,
		};
	});

	it("restores one shell when two browsers reconnect concurrently", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const original = await harness.connect();
		const pty = await original.createPty();
		const ready = `85kb-concurrent-ready-${randomUUID()}`;
		original.inputPty(pty.id, `stty -echo; ${printMarker(ready)}\n`);
		await waitForOutput(original, pty.id, ready);
		await harness.kill();
		await harness.restart({ skipBrowserProbe: true });
		const [first, second] = await Promise.all([
			harness.connect(),
			harness.connect(),
		]);
		const lists = await Promise.all([first.listPtys(), second.listPtys()]);
		for (const list of lists)
			expect(list.find(({ id }) => id === pty.id)).toMatchObject({
				pid: pty.pid,
				status: "running",
			});
		expect(alive(pty.pid)).toBe(true);
		const marker = `85kb-concurrent-live-${randomUUID()}`;
		const firstCursor = first.frames.length;
		const secondCursor = second.frames.length;
		first.inputPty(pty.id, `${printMarker(marker)}\n`);
		await Promise.all([
			waitForOutput(first, pty.id, marker, firstCursor),
			waitForOutput(second, pty.id, marker, secondCursor),
		]);
		expect(alive(pty.pid)).toBe(true);
		evidence = {
			shellPid: pty.pid,
			ptyId: pty.id,
			marker,
			firstBrowser: terminalOutput(first, pty.id),
			secondBrowser: terminalOutput(second, pty.id),
		};
	}, 60_000);

	it("delivers history then numbered live output once to each reconnecting browser", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const original = await harness.connect();
		const pty = await original.createPty();
		const prefix = `85kb-stream-${randomUUID()}`;
		const historical = `${prefix}:000`;
		const finalMarker = `${prefix}:040`;
		const start = join(harness.root, "start-stream-after-reconnect");
		const finished = join(harness.root, "numbered-stream-finished");
		const armed = `85kb-stream-armed-${randomUUID()}`;
		original.inputPty(pty.id, `stty -echo; ${printMarker(historical)}\n`);
		await waitForOutput(original, pty.id, historical);
		original.inputPty(
			pty.id,
			`(while [ ! -f ${shellQuote(start)} ]; do sleep 0.01; done; n=1; while [ "$n" -le 40 ]; do printf '%s%s:%03d\\n' ${shellQuote(prefix.slice(0, 4))} ${shellQuote(prefix.slice(4))} "$n"; n=$((n+1)); sleep 0.03; done; printf done > ${shellQuote(finished)}) &\n${printMarker(armed)}\n`,
		);
		await waitForOutput(original, pty.id, armed);
		await harness.kill();
		await harness.restart({ skipBrowserProbe: true });
		const [first, second] = await Promise.all([
			harness.connect(),
			harness.connect(),
		]);
		const pendingLists = Promise.all([first.listPtys(), second.listPtys()]);
		writeFileSync(start, "go");
		await pendingLists;
		await vi.waitFor(() => expect(existsSync(finished)).toBe(true), {
			timeout: 5000,
		});
		await Promise.all([
			waitForOutput(first, pty.id, finalMarker),
			waitForOutput(second, pty.id, finalMarker),
		]);
		const expected = Array.from({ length: 41 }, (_, index) => index);
		const numbers = (browser: ProcessBrowser): number[] =>
			Array.from(
				terminalOutput(browser, pty.id).matchAll(
					new RegExp(`${prefix}:(\\d{3})`, "g"),
				),
				(match) => Number(match[1]),
			);
		const outputOrder = (browser: ProcessBrowser) => ({
			metadata: browser.frames.findIndex(
				({ message }) =>
					(message["type"] === "pty_created" &&
						isRecord(message["pty"]) &&
						message["pty"]["id"] === pty.id) ||
					(message["type"] === "pty_list" &&
						Array.isArray(message["ptys"]) &&
						message["ptys"].some(
							(item: unknown) => isRecord(item) && item["id"] === pty.id,
						)),
			),
			output: browser.frames.findIndex(
				({ message }) =>
					message["type"] === "pty_output" && message["ptyId"] === pty.id,
			),
		});
		evidence = {
			assertionsCompleted: false,
			prefix,
			expected,
			firstBrowser: numbers(first),
			secondBrowser: numbers(second),
			firstOrder: outputOrder(first),
			secondOrder: outputOrder(second),
		};
		expect(numbers(first)).toEqual(expected);
		expect(numbers(second)).toEqual(expected);
		for (const browser of [first, second]) {
			const order = outputOrder(browser);
			expect(order.metadata).toBeGreaterThanOrEqual(0);
			expect(order.output).toBeGreaterThan(order.metadata);
		}
		await Promise.all([first.listPtys(), second.listPtys()]);
		expect(numbers(first)).toEqual(expected);
		expect(numbers(second)).toEqual(expected);
		const reusedOriginId = first.originId;
		await first.close();
		const sameClient = await harness.connect(undefined, reusedOriginId);
		await sameClient.listPtys();
		await waitForOutput(sameClient, pty.id, finalMarker);
		expect(numbers(sameClient)).toEqual(expected);
		expect(outputOrder(sameClient).output).toBeGreaterThan(
			outputOrder(sameClient).metadata,
		);
		await sameClient.listPtys();
		expect(numbers(sameClient)).toEqual(expected);
		expect(alive(pty.pid)).toBe(true);
		evidence = {
			...evidence,
			assertionsCompleted: true,
			shellPid: pty.pid,
			reusedOriginId,
			sameClient: numbers(sameClient),
		};
	}, 90_000);

	it.each([
		"restart",
		"stop",
	] as const)("shows terminal exit after explicit host %s and creates a working replacement", async (action) => {
		harness = await ProcessHarness.start({ dist: DIST });
		const browser = await harness.connect();
		const pty = await browser.createPty();
		const ready = `85kb-explicit-${action}-ready-${randomUUID()}`;
		browser.inputPty(pty.id, `stty -echo; ${printMarker(ready)}\n`);
		await waitForOutput(browser, pty.id, ready);
		const cursor = browser.frames.length;
		if (action === "restart") {
			const restarted = await restartPtyHost({ configDir: harness.configDir });
			clients.push(restarted);
		} else {
			expect(
				await stopPtyHost({ configDir: harness.configDir, force: true }),
			).toBe(true);
		}
		await vi.waitFor(() => expect(alive(pty.pid)).toBe(false));
		const listed = await browser.listPtys();
		const exits = browser.frames
			.slice(cursor)
			.filter(
				({ message }) =>
					(message["type"] === "pty_exited" ||
						message["type"] === "pty_deleted") &&
					message["ptyId"] === pty.id,
			);
		evidence = {
			assertionsCompleted: false,
			action,
			originalPty: pty,
			listed,
			exits: exits.map(({ message }) => message),
		};
		expect(listed.find(({ id }) => id === pty.id)?.status).not.toBe("running");
		expect(exits.length).toBeGreaterThan(0);
		const replacement = await browser.createPty();
		expect(replacement.pid).not.toBe(pty.pid);
		const marker = `85kb-after-explicit-${action}-${randomUUID()}`;
		browser.inputPty(replacement.id, `${printMarker(marker)}\n`);
		await waitForOutput(browser, replacement.id, marker);
		expect(alive(replacement.pid)).toBe(true);
		evidence = {
			...evidence,
			assertionsCompleted: true,
			replacement,
			marker,
		};
	}, 60_000);

	it("shares one host across simultaneous first connections", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		await stopPtyHost({ configDir: harness.configDir, force: true });
		const connections = await Promise.all([connect(), connect(), connect()]);
		expect(new Set(connections.map((client) => client.hello.pid)).size).toBe(1);
		const projectDir = harness.projectDir;
		const home = join(harness.root, "home");
		const sessions = await Promise.all(
			connections.map((client) =>
				client.create({
					cwd: projectDir,
					shell: "/bin/sh",
					env: { HOME: home },
				}),
			),
		);
		expect(new Set(sessions.map(({ pty }) => pty.pid)).size).toBe(3);
		expect((await connections[0]?.list(projectDir))?.length).toBe(3);
		evidence = {
			hosts: connections.map(({ hello }) => hello),
			terminals: sessions.map(({ pty }) => pty),
		};
	});

	it("recovers one working host after an idle host is killed with SIGKILL", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const old = await connect();
		expect(old.hello.openTerminals).toBe(0);
		const oldPid = old.hello.pid;
		process.kill(oldPid, "SIGKILL");
		await vi.waitFor(() => expect(alive(oldPid)).toBe(false));
		const connected = await Promise.all([
			connect(),
			connect(),
			connect(),
			connect(),
		]);
		expect(connected.every((client) => client.connected)).toBe(true);
		expect(new Set(connected.map(({ hello }) => hello.pid)).size).toBe(1);
		const client = connected[0];
		if (!client) throw new Error("No recovered PTY host connected");
		expect(client.hello.pid).not.toBe(oldPid);
		const session = await client.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		const marker = `85kb-recovered-host-${randomUUID()}`;
		let output = "";
		session.onData((data) => {
			output += data;
		});
		session.upstream.send(`${printMarker(marker)}\n`);
		await vi.waitFor(() => expect(output).toContain(marker));
		for (const connection of connected)
			expect(
				(await connection.list(harness.projectDir)).map(({ pty }) => pty.id),
			).toEqual([session.pty.id]);
		evidence = {
			oldHostPid: oldPid,
			recoveredHosts: connected.map(({ hello }) => hello),
			shellPid: session.pty.pid,
			marker,
		};
	});

	it("replays a bounded UTF-8 tail from the surviving host", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const first = await connect();
		const session = await first.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		const start = `85kb-trimmed-prefix-${randomUUID()}`;
		const end = `85kb-preserved-tail-${randomUUID()}`;
		let initial = "";
		session.onData((data) => {
			initial += data;
		});
		session.upstream.send(
			`stty -echo; ${printMarker(start)}; /usr/bin/awk 'BEGIN { for (i=0;i<100000;i++) printf "\\316\\273" }'; ${printMarker(end)}\n`,
		);
		await vi.waitFor(() => expect(initial).toContain(end), { timeout: 5000 });
		expect(Buffer.byteLength(initial)).toBeGreaterThan(PTY_SCROLLBACK_BYTES);
		first.disconnect();
		const second = await connect();
		const reattached = await second.attach(session.pty.id, harness.projectDir);
		let replay = "";
		reattached.onData((data) => {
			replay += data;
		});
		await vi.waitFor(() => expect(replay).toContain(end));
		expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(PTY_SCROLLBACK_BYTES);
		expect(replay).not.toContain(start);
		expect(replay).not.toContain("\ufffd");
		expect(replay.split(end)).toHaveLength(2);
		evidence = {
			host: second.hello,
			ptyId: session.pty.id,
			generatedBytes: Buffer.byteLength(initial),
			replayBytes: Buffer.byteLength(replay),
			scrollbackLimit: PTY_SCROLLBACK_BYTES,
			preservedMarker: end,
		};
	});

	it("retains a full replay window when live output follows server restoration", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const original = await harness.connect();
		const pty = await original.createPty();
		const suffix = randomUUID();
		const retained = `85kb-retained-tail-λ-${suffix}`;
		const ready = `85kb-full-window-ready-${randomUUID()}`;
		const live = `85kb-after-full-window-${randomUUID()}`;
		original.inputPty(
			pty.id,
			`stty -echo; /usr/bin/awk 'BEGIN { for (i=0;i<100000;i++) printf "x" }'; printf '%s\\316\\273%s\\n' '85kb-retained-tail-' '-${suffix}'; ${printMarker(ready)}\n`,
		);
		await waitForOutput(original, pty.id, ready);
		await harness.kill();
		await harness.restart({ skipBrowserProbe: true });
		const first = await harness.connect();
		await first.listPtys();
		const initialReplay = await waitForOutput(first, pty.id, ready);
		expect(initialReplay).toContain(retained);
		expect(Buffer.byteLength(initialReplay)).toBe(PTY_SCROLLBACK_BYTES);
		const cursor = first.frames.length;
		first.inputPty(pty.id, `${printMarker(live)}\n`);
		await waitForOutput(first, pty.id, live, cursor);
		const second = await harness.connect();
		await second.listPtys();
		const replay = await waitForOutput(second, pty.id, live);
		evidence = {
			assertionsCompleted: false,
			retainedMarker: retained,
			liveMarker: live,
			initialReplayBytes: Buffer.byteLength(initialReplay),
			secondReplayBytes: Buffer.byteLength(replay),
			retainedPosition: replay.indexOf(retained),
			livePosition: replay.indexOf(live),
			scrollbackLimit: PTY_SCROLLBACK_BYTES,
		};
		expect(replay).toContain(retained);
		expect(replay.indexOf(retained)).toBeLessThan(replay.indexOf(live));
		expect(Buffer.byteLength(replay)).toBeLessThanOrEqual(PTY_SCROLLBACK_BYTES);
		expect(replay).not.toContain("\ufffd");
		expect(replay.split(retained)).toHaveLength(2);
		expect(replay.split(live)).toHaveLength(2);
		evidence["assertionsCompleted"] = true;
	}, 60_000);

	it("upgrades an idle host and explicitly restarts or stops an active host", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const old = await oldHostFixture();
		const upgraded = await connect();
		expect(upgraded.hello.buildId).not.toBe("85kb-idle-old");
		expect(upgraded.hello.pid).not.toBe(old.hello.pid);
		await vi.waitFor(() => expect(alive(old.hello.pid)).toBe(false));
		const first = await upgraded.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		expect(
			await stopPtyHost({ configDir: harness.configDir, force: false }),
		).toBe(false);
		expect(alive(first.pty.pid)).toBe(true);
		const restarted = await restartPtyHost({
			configDir: harness.configDir,
		});
		clients.push(restarted);
		expect(restarted.hello.buildId).toBe(upgraded.hello.buildId);
		expect(restarted.hello.pid).not.toBe(upgraded.hello.pid);
		expect(await restarted.list(harness.projectDir)).toEqual([]);
		await vi.waitFor(() => expect(alive(first.pty.pid)).toBe(false));
		const second = await restarted.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		expect(
			await stopPtyHost({ configDir: harness.configDir, force: true }),
		).toBe(true);
		await vi.waitFor(() => expect(alive(second.pty.pid)).toBe(false));
		await vi.waitFor(() => expect(alive(restarted.hello.pid)).toBe(false));
		expect(
			await stopPtyHost({ configDir: harness.configDir, force: true }),
		).toBe(false);
		evidence = {
			oldHost: old.hello,
			idleUpgrade: upgraded.hello,
			explicitRestart: restarted.hello,
			stoppedShellPids: [first.pty.pid, second.pty.pid],
		};
	});

	it("shares one connected replacement across concurrent idle build upgrades", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const old = await oldHostFixture();
		const outcomes = await Promise.allSettled([
			connect(),
			connect(),
			connect(),
		]);
		const connected = outcomes.flatMap((outcome) =>
			outcome.status === "fulfilled" ? [outcome.value] : [],
		);
		evidence = {
			assertionsCompleted: false,
			oldHost: old.hello,
			outcomes: outcomes.map((outcome) =>
				outcome.status === "fulfilled"
					? {
							status: outcome.status,
							hello: outcome.value.hello,
							connected: outcome.value.connected,
						}
					: { status: outcome.status, error: String(outcome.reason) },
			),
		};
		expect(connected).toHaveLength(3);
		expect(connected.every((client) => client.connected)).toBe(true);
		expect(new Set(connected.map(({ hello }) => hello.pid)).size).toBe(1);
		for (const client of connected) {
			expect(client.hello.pid).not.toBe(old.hello.pid);
			expect(client.hello.buildId).not.toBe(old.hello.buildId);
			expect(await client.list(harness.projectDir)).toEqual([]);
		}
		await vi.waitFor(() => expect(alive(old.hello.pid)).toBe(false));
		evidence["assertionsCompleted"] = true;
	});

	it("identifies one working host for concurrent clients", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		await stopPtyHost({ configDir: harness.configDir, force: true });
		evidence = {
			assertionsCompleted: false,
		};
		const connected = await Promise.all([connect(), connect(), connect()]);
		expect(new Set(connected.map(({ hello }) => hello.pid)).size).toBe(1);
		const client = connected[0];
		if (!client) throw new Error("No PTY host connected");
		expect(alive(client.hello.pid)).toBe(true);
		const session = await client.create({
			cwd: harness.projectDir,
			shell: "/bin/sh",
			env: { HOME: join(harness.root, "home") },
		});
		const marker = `85kb-host-identity-${randomUUID()}`;
		let output = "";
		session.onData((data) => {
			output += data;
		});
		session.upstream.send(`${printMarker(marker)}\n`);
		await vi.waitFor(() => expect(output).toContain(marker));
		evidence = {
			...evidence,
			assertionsCompleted: true,
			host: client.hello,
			shellPid: session.pty.pid,
			marker,
		};
	}, 30_000);

	it("isolates terminals by project and fits a long config path in sun_path", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const configDir = join(harness.configDir, "long-config-path-".repeat(8));
		mkdirSync(configDir);
		const secondProject = join(harness.root, "second-project");
		mkdirSync(secondProject);
		const client = await PtyHostClient.connect({ configDir });
		clients.push(client);
		try {
			expect(Buffer.byteLength(ptyHostSocketPath(configDir))).toBeLessThan(104);
			const first = await client.create({
				cwd: harness.projectDir,
				shell: "/bin/sh",
				env: { HOME: join(harness.root, "home") },
			});
			const second = await client.create({
				cwd: secondProject,
				shell: "/bin/sh",
				env: { HOME: join(harness.root, "home") },
			});
			expect(
				(await client.list(harness.projectDir)).map(({ pty }) => pty.id),
			).toEqual([first.pty.id]);
			expect(
				(await client.list(secondProject)).map(({ pty }) => pty.id),
			).toEqual([second.pty.id]);
			await expect(
				client.attach(second.pty.id, harness.projectDir),
			).rejects.toThrow();
			evidence = {
				host: client.hello,
				configDir,
				socketPath: ptyHostSocketPath(configDir),
				projects: [first.pty, second.pty],
			};
		} finally {
			await stopPtyHost({ configDir, force: true });
			const socketPath = ptyHostSocketPath(configDir);
			const socketDirectory = dirname(socketPath);
			try {
				expect(
					lstatSync(socketPath, { throwIfNoEntry: false }),
				).toBeUndefined();
			} finally {
				if (
					lstatSync(socketDirectory).isSymbolicLink() &&
					realpathSync(socketDirectory) === realpathSync(configDir)
				)
					unlinkSync(socketDirectory);
			}
		}
	});

	it("refuses an incompatible host protocol and logs the mismatch", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const configDir = harness.configDir;
		await stopPtyHost({ configDir, force: true });
		const warnings: string[] = [];
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			socket.write(
				`${JSON.stringify({
					type: "hello",
					protocolVersion: 99,
					buildId: "incompatible",
					pid: process.pid,
					openTerminals: 1,
				})}\n`,
			);
		});
		await new Promise<void>((done, fail) => {
			server.once("error", fail);
			server.listen(ptyHostSocketPath(configDir), done);
		});
		try {
			await expect(
				PtyHostClient.connect({
					configDir: harness.configDir,
					start: false,
					log: { warn: (message) => warnings.push(message) },
				}),
			).rejects.toThrow(/protocol/i);
			expect(warnings.join("\n")).toMatch(/protocol/i);
			expect(warnings.join("\n")).toContain("99");
			evidence = { warnings, refusedProtocolVersion: 99 };
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((done) => server.close(() => done()));
		}
	});

	it.each([
		"stop",
		"restart",
	] as const)("explicitly %ss a protocol99 host over the stable control envelope", async (action) => {
		harness = await ProcessHarness.start({ dist: DIST });
		const configDir = harness.configDir;
		await stopPtyHost({ configDir, force: true });
		const sentinel = sentinelProcess();
		const fixture = await controlProtocolFixture(configDir, sentinel.pid);
		const warnings: string[] = [];
		try {
			await expect(
				PtyHostClient.connect({
					configDir,
					start: false,
					log: { warn: (message) => warnings.push(message) },
				}),
			).rejects.toThrow(/protocol/i);
			expect(warnings.join("\n")).toContain("99");
			evidence = {
				assertionsCompleted: false,
				action,
				advertisedPid: sentinel.pid,
				warnings,
				helloVersions: fixture.helloVersions,
				stops: fixture.stops,
			};
			if (action === "stop") {
				expect(await stopPtyHost({ configDir, force: true })).toBe(true);
			} else {
				const restarted = await restartPtyHost({ configDir });
				clients.push(restarted);
				expect(restarted.hello.protocolVersion).toBe(1);
				expect(restarted.hello.pid).not.toBe(sentinel.pid);
				evidence["replacementHost"] = restarted.hello;
			}
			expect(fixture.helloVersions).toEqual([1, 1, 99]);
			expect(fixture.stops).toEqual([{ version: 99, force: true }]);
			expect(alive(sentinel.pid)).toBe(true);
			evidence["assertionsCompleted"] = true;
		} finally {
			await fixture.close();
		}
	}, 30_000);

	it("fails safely when an incompatible host changes the control framing", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const configDir = harness.configDir;
		await stopPtyHost({ configDir, force: true });
		const sentinel = sentinelProcess();
		const fixture = await controlProtocolFixture(configDir, sentinel.pid, true);
		try {
			await expect(stopPtyHost({ configDir, force: true })).rejects.toThrow();
			expect(fixture.helloVersions).toEqual([1]);
			expect(fixture.stops).toEqual([]);
			expect(alive(sentinel.pid)).toBe(true);
			evidence = {
				advertisedPid: sentinel.pid,
				helloVersions: fixture.helloVersions,
				stops: fixture.stops,
			};
		} finally {
			await fixture.close();
		}
	});

	it("reconciles dead terminal IDs and rejects input after a real host crash", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const browser = await harness.connect();
		const pty = await browser.createPty();
		const host = await connect();
		const marker = `85kb-before-host-crash-${randomUUID()}`;
		browser.inputPty(pty.id, `stty -echo; ${printMarker(marker)}\n`);
		await waitForOutput(browser, pty.id, marker);
		const cursor = browser.frames.length;
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			ptyId: pty.id,
			phase: "waiting-for-host-crash-notification",
		};
		process.kill(host.hello.pid, "SIGKILL");
		const notificationBeforeList = await vi
			.waitFor(
				() =>
					expect(
						browser.frames
							.slice(cursor)
							.some(
								({ message }) =>
									message["ptyId"] === pty.id &&
									(message["type"] === "pty_exited" ||
										message["type"] === "pty_deleted"),
							),
					).toBe(true),
				{ timeout: 2_000 },
			)
			.then(
				() => true,
				() => false,
			);
		expect(browser.connected).toBe(true);
		await vi.waitFor(() => expect(alive(pty.pid)).toBe(false));
		evidence["phase"] = "waiting-for-rejected-input";
		const inputCursor = browser.frames.length;
		browser.inputPty(pty.id, "printf 'must-not-run\\n'\n");
		const inputRejected = await browser
			.waitFor(
				(message) =>
					message["type"] === "system_error" &&
					message["code"] === "PTY_INPUT_FAILED",
				inputCursor,
			)
			.then(
				() => true,
				() => false,
			);
		const listed = await browser.listPtys();
		evidence = {
			...evidence,
			notificationBeforeList,
			inputRejected,
			listedIds: listed.map((entry) => entry.id),
			phase: "host-crash-observed",
		};
		expect(notificationBeforeList).toBe(true);
		expect(inputRejected).toBe(true);
		expect(listed.some((entry) => entry.id === pty.id)).toBe(false);
		const replacement = await browser.createPty();
		const replacementMarker = `85kb-after-host-crash-${randomUUID()}`;
		browser.inputPty(replacement.id, `${printMarker(replacementMarker)}\n`);
		await waitForOutput(browser, replacement.id, replacementMarker);
		expect(replacement.id).not.toBe(pty.id);
		expect(alive(replacement.pid)).toBe(true);
		evidence = {
			...evidence,
			assertionsCompleted: true,
			phase: "replacement-working",
			listedIds: listed.map((entry) => entry.id),
			replacementId: replacement.id,
			replacementPid: replacement.pid,
		};
	}, 60_000);

	it("keeps the shell's inherited umask while IPC stays private", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const host = await oldHostFixture(BUILD_ID);
		const browser = await harness.connect();
		const pty = await browser.createPty();
		const file = join(harness.root, "shell-created-file");
		const mask = join(harness.root, "shell-umask");
		const marker = `85kb-umask-${randomUUID()}`;
		browser.inputPty(
			pty.id,
			`stty -echo; umask > ${shellQuote(mask)}; : > ${shellQuote(file)}; ${printMarker(marker)}\n`,
		);
		await waitForOutput(browser, pty.id, marker);
		const actualMask = readFileSync(mask, "utf8").trim();
		const outputMode = statSync(file).mode & 0o777;
		const socketMode =
			statSync(ptyHostSocketPath(harness.configDir)).mode & 0o777;
		const lockMode =
			statSync(join(harness.configDir, ".pty-host-lock")).mode & 0o777;
		evidence = {
			assertionsCompleted: false,
			hostPid: host.hello.pid,
			buildId: host.hello.buildId,
			shellPid: pty.pid,
			inheritedMask: "0022",
			actualMask,
			outputMode: outputMode.toString(8),
			socketMode: socketMode.toString(8),
			lockMode: lockMode.toString(8),
		};
		expect(actualMask).toBe("0022");
		expect(outputMode).toBe(0o644);
		expect(socketMode).toBe(0o600);
		expect(lockMode).toBe(0o700);
		evidence["assertionsCompleted"] = true;
	}, 60_000);

	it("records a real input echo comparison against in-process node-pty", async () => {
		harness = await ProcessHarness.start({ dist: DIST });
		const env = {
			PATH: process.env["PATH"] ?? "",
			HOME: join(harness.root, "home"),
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
			COLORTERM: "truecolor",
			CONDUIT: "1",
		};
		const client = await connect();
		const hosted = await client.create({
			cwd: harness.projectDir,
			shell: env.SHELL,
			env,
		});
		const local = nodePty.spawn(env.SHELL, [], {
			name: env.TERM,
			cwd: harness.projectDir,
			env,
			cols: 80,
			rows: 24,
		});
		const localEcho = echoProbe(
			(handler) => local.onData(handler),
			(data) => local.write(data),
		);
		const hostedEcho = echoProbe(
			(handler) => hosted.onData(handler),
			(data) => hosted.upstream.send(data),
		);
		const warmup = 20;
		const samples = 200;
		const localUs: number[] = [];
		const hostedUs: number[] = [];
		try {
			for (let index = 0; index < warmup + samples; index++) {
				const token = `echo${String(index).padStart(4, "0")}x`;
				const measureLocal = async () => {
					const elapsed = await localEcho(token);
					if (index >= warmup) localUs.push(elapsed);
				};
				const measureHosted = async () => {
					const elapsed = await hostedEcho(token);
					if (index >= warmup) hostedUs.push(elapsed);
				};
				if (index % 2 === 0) {
					await measureLocal();
					await measureHosted();
				} else {
					await measureHosted();
					await measureLocal();
				}
			}
			const inProcess = percentiles(localUs);
			const viaHost = percentiles(hostedUs);
			const measurement = {
				measuredAt: new Date().toISOString(),
				builtDist: DIST,
				serverBuildId: BUILD_ID,
				hostBuildId: client.hello.buildId,
				hostPid: client.hello.pid,
				method:
					"Alternating terminal input echo, same /bin/sh and environment; Ctrl-U clears each token without executing shell commands",
				unit: "microseconds",
				platform: process.platform,
				architecture: process.arch,
				node: process.version,
				warmup,
				samples,
				inProcess,
				viaHost,
				delta: {
					p50: viaHost.p50 - inProcess.p50,
					p99: viaHost.p99 - inProcess.p99,
				},
				inProcessSamples: localUs,
				viaHostSamples: hostedUs,
			};
			expect(localUs).toHaveLength(samples);
			expect(hostedUs).toHaveLength(samples);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/85kb-11-latency.json",
				JSON.stringify(measurement, null, 2),
			);
			evidence = measurement;
		} finally {
			local.kill();
			hosted.upstream.close();
		}
	});
});

function echoProbe(
	onData: (handler: (data: string) => void) => void,
	write: (data: string) => void,
): (token: string) => Promise<number> {
	let output = "";
	let pending:
		| { token: string; started: bigint; done: (us: number) => void }
		| undefined;
	onData((data) => {
		output += data;
		if (!pending || !output.includes(pending.token)) return;
		const elapsed = Number(process.hrtime.bigint() - pending.started) / 1000;
		pending.done(elapsed);
		pending = undefined;
		output = "";
	});
	return (token) =>
		new Promise((done, fail) => {
			const timer = setTimeout(() => {
				pending = undefined;
				fail(new Error(`Terminal echo timed out for ${token}`));
			}, 5000);
			pending = {
				token,
				started: process.hrtime.bigint(),
				done: (us) => {
					clearTimeout(timer);
					write("\u0015");
					done(us);
				},
			};
			write(token);
		});
}

function percentiles(samples: number[]): { p50: number; p99: number } {
	const sorted = [...samples].sort((left, right) => left - right);
	return {
		p50: sorted[Math.ceil(samples.length * 0.5) - 1] ?? 0,
		p99: sorted[Math.ceil(samples.length * 0.99) - 1] ?? 0,
	};
}
