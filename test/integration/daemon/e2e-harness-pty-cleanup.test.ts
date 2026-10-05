import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	PtyInfoSchema,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import * as hostApi from "../../../src/lib/terminal/pty-host-client.js";
import { ptyHostSocketPath } from "../../../src/lib/terminal/pty-host-protocol.js";
import {
	createReplayHarness,
	type ReplayHarness,
} from "../../e2e/helpers/e2e-harness.js";
import { TestWsClient } from "../helpers/test-ws-client.js";

const ARTIFACT_DIR = resolve("test-results/85kb-11/second-pass");
const THIRD_PASS_DIR = resolve("test-results/85kb-11/third-pass");
const requireFromHere = createRequire(import.meta.url);

function alive(pid: number | undefined): boolean {
	if (pid === undefined) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("E2E harness PTY teardown", () => {
	it.each([
		"ready",
		"starting",
		"losing",
	] as const)("leaves no detached startup contender after the exact replay fixture worker exits (%s)", async (startupState) => {
		const root = realpathSync(
			mkdtempSync("/tmp/conduit-process-playwright-pty-cleanup-"),
		);
		const projectDir = join(root, "project");
		const home = join(root, "home");
		mkdirSync(projectDir);
		mkdirSync(home);
		writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
		const eventsPath = join(root, "spawn-events.jsonl");
		const releasePath = join(root, "release-contenders");
		const wrapper = join(root, "host-wrapper.mjs");
		const preload = join(root, "spawn-preload.mjs");
		const spec = join(root, "worker.spec.ts");
		const config = join(root, "playwright.config.cjs");
		const workerResult = join(root, "worker-result.json");
		const stopAtReturn = join(root, "stop-at-return.json");
		const fixture = fileURLToPath(
			new URL("../../e2e/helpers/replay-fixture.ts", import.meta.url),
		);
		const probe = fileURLToPath(
			new URL(
				"../../../src/lib/provider/claude/claude-capabilities-probe.ts",
				import.meta.url,
			),
		);
		const wsClient = fileURLToPath(
			new URL("../helpers/test-ws-client.ts", import.meta.url),
		);
		const contract = fileURLToPath(
			new URL("../../../src/lib/contracts/ws-rpc.ts", import.meta.url),
		);
		const clientModule = fileURLToPath(
			new URL("../../../src/lib/terminal/pty-host-client.ts", import.meta.url),
		);
		writeFileSync(
			wrapper,
			`import { appendFileSync, existsSync } from 'node:fs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.env.CONDUIT_TEST_CANDIDATE === '0') await wait(1300);
else while (!existsSync(${JSON.stringify(releasePath)})) await wait(20);
await import(process.env.CONDUIT_TEST_HOST_ENTRY);
appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({stage:'loaded',pid:process.pid})+'\\n');
`,
		);
		writeFileSync(
			preload,
			`import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const original = childProcess.spawn;
const counts = new Map();
childProcess.spawn = (command,args,options) => {
 const entry=args?.at(-1);
 const configDir=options?.env?.CONDUIT_CONFIG_DIR;
 if (!entry?.endsWith('/bin/pty-host.ts') || !configDir?.startsWith(${JSON.stringify(`${root}/`)})) return original(command,args,options);
 const index=counts.get(configDir)??0;
 counts.set(configDir,index+1);
 const child=original(command,[...args.slice(0,-1),${JSON.stringify(wrapper)}],{...options,env:{...options.env,CONDUIT_TEST_CANDIDATE:String(index),CONDUIT_TEST_HOST_ENTRY:pathToFileURL(entry).href}});
 appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({stage:'spawn',pid:child.pid,configDir,index})+'\\n');
 child.once('exit',()=>appendFileSync(${JSON.stringify(eventsPath)},JSON.stringify({stage:'exit',pid:child.pid})+'\\n'));
 return child;
};
syncBuiltinESMExports();
`,
		);
		writeFileSync(
			spec,
			`import {test,expect} from ${JSON.stringify(fixture)};
import {__setProbeOverrideForTesting} from ${JSON.stringify(probe)};
import {TestWsClient} from ${JSON.stringify(wsClient)};
import {WsRpcGroup,PtyInfoSchema} from ${JSON.stringify(contract)};
import {PtyHostClient} from ${JSON.stringify(clientModule)};
import {dirname} from 'node:path';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Effect,Schema}=require(${JSON.stringify(requireFromHere.resolve("effect"))});
const {Socket}=require(${JSON.stringify(requireFromHere.resolve("@effect/platform"))});
const {RpcClient,RpcSerialization}=require(${JSON.stringify(requireFromHere.resolve("@effect/rpc"))});
__setProbeOverrideForTesting(async()=>({models:[],commands:[],agents:[]}));
test('actual replay fixture worker',async({harness})=>{
 const browser=new TestWsClient('ws://127.0.0.1:'+harness.relayPort+'/ws',harness.stack.initialSessionId);
 await browser.waitForOpen();
 const originId=browser.getClientId();
 const creation=${JSON.stringify(startupState)}==='losing'?Promise.resolve():Effect.runPromise(Effect.scoped(Effect.gen(function*(){
  const client=yield* RpcClient.make(WsRpcGroup);
  yield* client.CreatePty({projectSlug:'e2e-replay',originId});
 })).pipe(Effect.provide(RpcClient.layerProtocolSocket()),Effect.provide(Socket.layerWebSocket('ws://127.0.0.1:'+harness.relayPort+'/rpc')),Effect.provide(Socket.layerWebSocketConstructorGlobal),Effect.provide(RpcSerialization.layerJson)));
 const configDir=dirname(harness.eventsDbPath);
 let host;
 if (${JSON.stringify(startupState)}==='losing') {
  const winner=PtyHostClient.connect({configDir});
  await expect.poll(()=>existsSync(${JSON.stringify(eventsPath)})&&readFileSync(${JSON.stringify(eventsPath)},'utf8').includes('spawn')).toBe(true);
  void PtyHostClient.connect({configDir,buildId:'cancelled-idle-upgrader'}).then(client=>{client.disconnect();writeFileSync(${JSON.stringify(join(root, "losing-result.json"))},'returned');}).catch(error=>writeFileSync(${JSON.stringify(join(root, "losing-result.json"))},error.message));
  host=await winner;
  writeFileSync(${JSON.stringify(workerResult)},JSON.stringify({configDir,host:host.hello,forcedDuringLoserJoin:true}));
 } else if (${JSON.stringify(startupState)}==='ready') {
  await creation;
  await browser.subscribePtys('e2e-replay');
  const snapshot=await browser.waitFor('pty',{predicate:m=>m._tag==='snapshot'});
  const pty=Schema.decodeUnknownSync(PtyInfoSchema)(snapshot.rows[0].pty);
  host=await PtyHostClient.connect({configDir,start:false});
  writeFileSync(${JSON.stringify(workerResult)},JSON.stringify({configDir,host:host.hello,shellPid:pty.pid}));
 } else {
  void creation.catch(()=>undefined);
  await expect.poll(()=>existsSync(${JSON.stringify(eventsPath)})&&readFileSync(${JSON.stringify(eventsPath)},'utf8').includes('spawn')).toBe(true);
  writeFileSync(${JSON.stringify(workerResult)},JSON.stringify({configDir,stoppedWhileStarting:true}));
 }
 const originalStop=harness.stop.bind(harness);
 harness.stop=async()=>{
  await originalStop();
  const spawns=readFileSync(${JSON.stringify(eventsPath)},'utf8').trim().split('\\n').map(line=>JSON.parse(line)).filter(event=>event.stage==='spawn'&&event.configDir===configDir);
  const livePids=spawns.filter(({pid})=>{try{process.kill(pid,0);return true;}catch{return false;}}).map(({pid})=>pid);
  writeFileSync(${JSON.stringify(stopAtReturn)},JSON.stringify({configDir,livePids}));
 };
 host?.disconnect();
 await browser.close();
});
test.afterAll(()=>writeFileSync(${JSON.stringify(releasePath)},'worker fixtures torn down'));
`,
		);
		writeFileSync(
			config,
			`module.exports={testDir:__dirname,testMatch:'worker.spec.ts',workers:1,retries:0,timeout:20000,reporter:[['json',{outputFile:${JSON.stringify(join(root, "playwright-report.json"))}}]]};\n`,
		);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			HOME: home,
			SHELL: "/bin/sh",
			TMPDIR: root,
			CONDUIT_CONFIG_DIR: join(root, "unused-default"),
			NODE_OPTIONS: `--import=${preload}`,
		};
		delete env["ENV"];
		delete env["BASH_ENV"];
		let output = "";
		const child = spawn(
			process.execPath,
			[
				requireFromHere.resolve("@playwright/test/cli"),
				"test",
				"--config",
				config,
			],
			{ cwd: projectDir, env, stdio: ["ignore", "pipe", "pipe"] },
		);
		child.stdout.on("data", (data: Buffer) => {
			output = (output + data.toString()).slice(-5000);
		});
		child.stderr.on("data", (data: Buffer) => {
			output = (output + data.toString()).slice(-5000);
		});
		const readEvents = (): Array<{
			stage: string;
			pid: number;
			configDir?: string;
			index?: number;
		}> =>
			existsSync(eventsPath)
				? readFileSync(eventsPath, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [];
		let passed = false;
		const evidence: Record<string, unknown> = { root, fixture };
		try {
			const exitCode = await new Promise<number | null>((done, fail) => {
				child.once("error", fail);
				child.once("exit", done);
			});
			evidence["workerExitCode"] = exitCode;
			evidence["workerOutput"] = output;
			expect(exitCode, output).toBe(0);
			const result = JSON.parse(readFileSync(workerResult, "utf8")) as {
				configDir: string;
				shellPid?: number;
			};
			const spawns = readEvents().filter(({ stage }) => stage === "spawn");
			const atReturn = JSON.parse(readFileSync(stopAtReturn, "utf8")) as {
				configDir: string;
				livePids: number[];
			};
			Object.assign(evidence, { result, spawns, atReturn });
			await vi.waitFor(
				() => {
					const loaded = new Set(
						readEvents()
							.filter(({ stage }) => stage === "loaded")
							.map(({ pid }) => pid),
					);
					expect(
						spawns.every(({ pid }) => loaded.has(pid) || !alive(pid)),
					).toBe(true);
					if (spawns.some(({ pid }) => alive(pid)))
						expect(existsSync(ptyHostSocketPath(result.configDir))).toBe(true);
				},
				{ timeout: 5_000 },
			);
			evidence["liveSpawnPidsAfterWorkerExit"] = spawns
				.filter(({ pid }) => alive(pid))
				.map(({ pid }) => pid);
			evidence["configRecreatedAfterTeardown"] = existsSync(result.configDir);
			expect(atReturn.livePids).toEqual([]);
			expect(evidence["liveSpawnPidsAfterWorkerExit"]).toEqual([]);
			expect(alive(result.shellPid)).toBe(false);
			expect(existsSync(result.configDir)).toBe(false);
			passed = true;
		} finally {
			writeFileSync(releasePath, "release cleanup");
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await vi.waitFor(() =>
					expect(child.exitCode !== null || child.signalCode !== null).toBe(
						true,
					),
				);
			}
			const spawns = readEvents().filter(({ stage }) => stage === "spawn");
			const configs = new Set(spawns.map(({ configDir }) => configDir));
			const deadline = Date.now() + 7_000;
			while (spawns.some(({ pid }) => alive(pid)) && Date.now() < deadline) {
				for (const configDir of configs)
					if (configDir?.startsWith(`${root}/`))
						await hostApi.stopPtyHost({ configDir, force: true });
				await new Promise((done) => setTimeout(done, 25));
			}
			expect(spawns.filter(({ pid }) => alive(pid))).toEqual([]);
			evidence["assertionsCompleted"] = passed;
			evidence["cleanupHostsStopped"] = true;
			mkdirSync(THIRD_PASS_DIR, { recursive: true });
			writeFileSync(
				join(
					THIRD_PASS_DIR,
					`replay-worker-${startupState}-cleanup-${passed ? "passed" : "failed"}.json`,
				),
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
			rmSync(root, { recursive: true, force: true });
		}
	}, 45_000);

	it("stops its detached host and shell without stopping another isolated host", async () => {
		const root = mkdtempSync("/tmp/conduit-process-e2e-cleanup-");
		const projectDir = join(root, "project");
		const home = join(root, "home");
		const sentinelConfig = join(root, "sentinel");
		mkdirSync(projectDir);
		mkdirSync(home);
		vi.stubEnv("HOME", home);
		vi.stubEnv("SHELL", "/bin/sh");
		vi.stubEnv("ENV", undefined);
		vi.stubEnv("BASH_ENV", undefined);
		vi.stubEnv("TMPDIR", root);
		vi.stubEnv("CONDUIT_CONFIG_DIR", join(root, "unused-default"));
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
		let harness: ReplayHarness | undefined;
		let browser: TestWsClient | undefined;
		let primary: hostApi.PtyHostClient | undefined;
		let sentinel: hostApi.PtyHostClient | undefined;
		let shellPid: number | undefined;
		let sentinelShellPid: number | undefined;
		let stopped = false;
		let passed = false;
		const evidence: Record<string, unknown> = { root };
		try {
			harness = await createReplayHarness("chat-simple", { projectDir });
			const configDir = dirname(harness.eventsDbPath);
			browser = new TestWsClient(
				`ws://127.0.0.1:${harness.relayPort}/ws`,
				harness.stack.initialSessionId,
			);
			await browser.waitForOpen();
			await browser.subscribePtys("e2e-replay");
			const originId = browser.getClientId();
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.CreatePty({
							projectSlug: "e2e-replay",
							originId,
						});
					}),
				).pipe(
					Effect.provide(RpcClient.layerProtocolSocket()),
					Effect.provide(
						Socket.layerWebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`),
					),
					Effect.provide(Socket.layerWebSocketConstructorGlobal),
					Effect.provide(RpcSerialization.layerJson),
				),
			);
			const created = await browser.waitFor("pty", {
				predicate: (message) => message["_tag"] === "upsert",
			});
			const pty = Schema.decodeUnknownSync(PtyInfoSchema)(created["item"]);
			shellPid = pty.pid;
			primary = await hostApi.PtyHostClient.connect({
				configDir,
				start: false,
			});
			await primary.attach(pty.id, projectDir);
			primary.send({
				type: "input",
				id: pty.id,
				data: "printf '85kb-cleanup-pid:%s\\n' \"$$\"\n",
			});
			await vi.waitFor(() => {
				const output = browser
					?.getReceivedOfType("pty")
					.filter((message) => message["_tag"] === "output")
					.map((message) => message["data"])
					.join("");
				expect(output).toContain(`85kb-cleanup-pid:${shellPid}`);
			});
			sentinel = await hostApi.PtyHostClient.connect({
				configDir: sentinelConfig,
			});
			const other = await sentinel.create({
				cwd: projectDir,
				shell: "/bin/sh",
				env: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
			});
			sentinelShellPid = other.pty.pid;
			Object.assign(evidence, {
				configDir,
				socketPath: ptyHostSocketPath(configDir),
				host: primary.hello,
				shellPid,
				sentinelHost: sentinel.hello,
				sentinelShellPid,
				markerObserved: true,
			});
			expect(alive(primary.hello.pid)).toBe(true);
			expect(alive(shellPid)).toBe(true);
			await browser.close();
			await harness.stop();
			stopped = true;
			expect(alive(primary.hello.pid)).toBe(false);
			expect(alive(shellPid)).toBe(false);
			await vi.waitFor(
				() => {
					evidence["hostAliveAfterStop"] = alive(primary?.hello.pid);
					evidence["shellAliveAfterStop"] = alive(shellPid);
					expect(evidence["hostAliveAfterStop"]).toBe(false);
					expect(evidence["shellAliveAfterStop"]).toBe(false);
				},
				{ timeout: 3_000 },
			);
			expect(existsSync(configDir)).toBe(false);
			expect(existsSync(ptyHostSocketPath(configDir))).toBe(false);
			expect(alive(sentinel.hello.pid)).toBe(true);
			expect(alive(sentinelShellPid)).toBe(true);
			expect(
				(await sentinel.list(projectDir)).map(({ pty }) => pty.id),
			).toEqual([other.pty.id]);
			evidence["sentinelSurvived"] = true;
			passed = true;
		} finally {
			await browser?.close();
			// Keep this verified connection for cleanup even when the regression
			// deletes its socket directory while the detached process is alive.
			if (primary?.connected)
				primary.send({ type: "stop", requestId: 1_000_000, force: true });
			await hostApi.stopPtyHost({ configDir: sentinelConfig, force: true });
			await vi.waitFor(
				() => {
					expect(alive(primary?.hello.pid)).toBe(false);
					expect(alive(shellPid)).toBe(false);
					expect(alive(sentinel?.hello.pid)).toBe(false);
					expect(alive(sentinelShellPid)).toBe(false);
				},
				{ timeout: 5_000 },
			);
			primary?.disconnect();
			sentinel?.disconnect();
			if (!stopped) await harness?.stop();
			__setProbeOverrideForTesting(undefined);
			vi.unstubAllEnvs();
			evidence["assertionsCompleted"] = passed;
			evidence["cleanupHostsStopped"] = true;
			mkdirSync(ARTIFACT_DIR, { recursive: true });
			writeFileSync(
				join(
					ARTIFACT_DIR,
					`e2e-harness-cleanup-${passed ? "passed" : "failed"}.json`,
				),
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
			rmSync(root, { recursive: true, force: true });
		}
	}, 40_000);

	it("preserves the isolated control directory when host stop fails", async () => {
		const root = mkdtempSync("/tmp/conduit-process-e2e-stop-failure-");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		vi.stubEnv("TMPDIR", root);
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
		const harness = await createReplayHarness("chat-simple", { projectDir });
		const configDir = dirname(harness.eventsDbPath);
		const stop = vi
			.spyOn(hostApi, "stopPtyHost")
			.mockRejectedValueOnce(new Error("isolated host shutdown failed"));
		try {
			await expect(harness.stop()).rejects.toThrow(
				"isolated host shutdown failed",
			);
			expect(existsSync(configDir)).toBe(true);
		} finally {
			stop.mockRestore();
			await harness.stop();
			__setProbeOverrideForTesting(undefined);
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([
		"relay",
		"mock",
	] as const)("stops its isolated host when upstream teardown fails (%s)", async (failingStop) => {
		const root = mkdtempSync("/tmp/conduit-process-e2e-teardown-failure-");
		const projectDir = join(root, "project");
		mkdirSync(projectDir);
		vi.stubEnv("TMPDIR", root);
		vi.stubEnv("HOME", root);
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
		const harness = await createReplayHarness("chat-simple", { projectDir });
		const configDir = dirname(harness.eventsDbPath);
		const primary = await hostApi.PtyHostClient.connect({ configDir });
		const { pty } = await primary.create({
			cwd: projectDir,
			shell: "/bin/sh",
			env: { HOME: root, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
		});
		const stop = vi
			.spyOn(failingStop === "relay" ? harness.stack : harness.mock, "stop")
			.mockRejectedValueOnce(new Error(`${failingStop} teardown failed`));
		let passed = false;
		const evidence: Record<string, unknown> = {
			configDir,
			hostPid: primary.hello.pid,
			shellPid: pty.pid,
		};
		try {
			await expect(harness.stop()).rejects.toThrow(
				`${failingStop} teardown failed`,
			);
			expect(existsSync(configDir)).toBe(true);
			await vi.waitFor(
				() => {
					evidence["hostAliveAfterStop"] = alive(primary.hello.pid);
					evidence["shellAliveAfterStop"] = alive(pty.pid);
					expect(evidence["hostAliveAfterStop"]).toBe(false);
					expect(evidence["shellAliveAfterStop"]).toBe(false);
				},
				{ timeout: 1_000 },
			);
			passed = true;
		} finally {
			stop.mockRestore();
			if (primary.connected)
				primary.send({ type: "stop", requestId: 1_000_000, force: true });
			await vi.waitFor(() => {
				expect(alive(primary.hello.pid)).toBe(false);
				expect(alive(pty.pid)).toBe(false);
			});
			primary.disconnect();
			await harness.stop();
			__setProbeOverrideForTesting(undefined);
			vi.unstubAllEnvs();
			evidence["assertionsCompleted"] = passed;
			evidence["cleanupHostsStopped"] = true;
			mkdirSync(ARTIFACT_DIR, { recursive: true });
			writeFileSync(
				join(
					ARTIFACT_DIR,
					`e2e-${failingStop}-failure-${passed ? "passed" : "failed"}.json`,
				),
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
