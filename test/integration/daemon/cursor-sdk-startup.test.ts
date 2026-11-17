// Failure modes: restart defers evaluation into an RPC, listen races an async
// import, unused/replayed Cursor loads the SDK, or a failed import stops serving.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cursorCredentialStorePath } from "../../../src/lib/provider/cursor/cursor-sdk.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface Observation {
	readonly phase: string;
	readonly at: number;
	readonly pid: number;
}

const artifacts = "test-results/conduit-test-g43i.28.1";
const accountId = "cursor-startup";
const scenarios: Record<string, unknown>[] = [];

describe("Cursor SDK startup through the daemon process", () => {
	let harness: ProcessHarness | undefined;
	let observationPath = "";
	let logPath = "";
	let evidence: Record<string, unknown> = {};

	const observations = (): Observation[] =>
		existsSync(observationPath)
			? readFileSync(observationPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Observation)
			: [];

	async function start(
		name: string,
		options: {
			cursor?: boolean;
			adopted?: boolean;
			failLoad?: boolean;
			replay?: boolean;
		} = {},
	) {
		mkdirSync(artifacts, { recursive: true });
		observationPath = resolve(artifacts, `${name}.jsonl`);
		logPath = resolve(artifacts, `${name}.log`);
		writeFileSync(observationPath, "");
		writeFileSync(logPath, "");
		evidence = { scenario: name };
		harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			logLevel: "warn",
		});
		const fixture = harness;
		if (options.cursor) {
			const configPath = join(fixture.configDir, "daemon.json");
			const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
				string,
				unknown
			>;
			writeFileSync(
				configPath,
				JSON.stringify({
					...config,
					instances: [
						{
							id: accountId,
							name: "Cursor",
							driver: "cursor",
							port: 0,
							managed: false,
						},
					],
				}),
			);
		}
		if (options.adopted) {
			const marker = join(fixture.configDir, "cursor/legacy-auth-adopted");
			mkdirSync(join(fixture.configDir, "cursor"), { recursive: true });
			writeFileSync(
				marker,
				cursorCredentialStorePath(accountId, fixture.configDir),
			);
			writeFileSync(`${marker}.complete`, "");
		}
		const preload = join(fixture.root, "cursor-startup-observer.mjs");
		// Instrument the installed SDK, not a replacement port. The async delay
		// makes a fire-and-forget preload observably race listen on every machine.
		writeFileSync(
			preload,
			`import { appendFileSync } from "node:fs";
import { Server as HttpServer } from "node:http";
import { Server } from "node:net";
import { registerHooks } from "node:module";
const path = ${JSON.stringify(observationPath)};
const record = phase => appendFileSync(path, JSON.stringify({ phase, at: performance.timeOrigin + performance.now(), pid: process.pid }) + "\\n");
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (this instanceof HttpServer && (event === "listening" || event === "connection")) record(event);
  return Reflect.apply(emit, this, [event, ...args]);
};
let sdkUrl;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (specifier === "@cursor/sdk") sdkUrl = result.url;
    return result;
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== sdkUrl) return result;
    const prefix = 'import { appendFileSync as startupAppend } from "node:fs";\\n' +
      'const startupRecord = phase => startupAppend(' + JSON.stringify(path) + ', JSON.stringify({phase, at: performance.timeOrigin + performance.now(), pid: process.pid}) + "\\\\n");\\n' +
      'startupRecord("sdk-load-started");\\n' +
      'await new Promise(done => setTimeout(done, 200));\\n' +
      ${JSON.stringify(options.failLoad ? 'throw new Error("Cursor startup import failure");\n' : "")};
    return { ...result, source: prefix + result.source + '\\nstartupRecord("sdk-load-finished");\\n' };
  },
});
`,
		);
		await fixture.restart({
			startupTimeoutMs: 60_000,
			skipBrowserProbe: true,
			logFile: logPath,
			serviceEnvironment: {
				NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
				CONDUIT_SLOW_RPC_MS: "100",
				...(options.replay
					? {
							CONDUIT_CURSOR_SDK_TRACE: resolve(
								"test/fixtures/cursor-sdk-traces/basic.jsonl",
							),
						}
					: {}),
			},
		});
		return fixture;
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		try {
			await harness.dispose();
		} finally {
			const observed = observations();
			const logs = readFileSync(logPath, "utf8");
			scenarios.push({
				...evidence,
				result: task.result?.state,
				failures: task.result?.errors?.map(({ message }) => message) ?? [],
				loadFinishedAt:
					observed.find(({ phase }) => phase === "sdk-load-finished")?.at ??
					null,
				listenAt:
					observed.find(({ phase }) => phase === "listening")?.at ?? null,
				observations: observed,
				slowRpcLines: logs
					.split("\n")
					.filter((line) => line.includes("slow rpc")),
				remainingRunnerPids: harness.remainingRunnerPids(),
			});
			writeFileSync(
				`${artifacts}.json`,
				`${JSON.stringify({ ticket: "conduit-test-g43i.28.1", scenarios }, null, 2)}\n`,
			);
			harness = undefined;
		}
	});

	it("finishes the real SDK load before listen after restart and keeps the first Cursor RPC fast", async () => {
		const fixture = await start("restart", { cursor: true, adopted: true });
		const beforeRpc = observations();
		const browser = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const started = performance.now();
		const models = await browser.getModels(accountId);
		evidence["firstCursorRpcMs"] = performance.now() - started;
		evidence["models"] = models;
		const loaded = beforeRpc.find(({ phase }) => phase === "sdk-load-finished");
		const listening = beforeRpc.find(({ phase }) => phase === "listening");
		expect.soft(loaded, "SDK must finish before the first RPC").toBeDefined();
		expect.soft(loaded?.at ?? Infinity).toBeLessThan(listening?.at ?? 0);
		const connection = observations().find(
			({ phase }) => phase === "connection",
		);
		expect.soft(loaded?.at ?? Infinity).toBeLessThan(connection?.at ?? 0);
		// Closing the process drains its log pipes before inspecting warnings.
		await fixture.terminate();
		expect(readFileSync(logPath, "utf8")).not.toContain("slow rpc");
	});

	it.each([
		["unused", false],
		["replay", true],
	] as const)("never imports the real SDK for %s Cursor", async (name, replay) => {
		const fixture = await start(name, { cursor: replay, replay });
		if (!replay)
			expect(
				readFileSync(
					join(fixture.configDir, "cursor/legacy-auth-adopted"),
					"utf8",
				),
			).toBe(
				cursorCredentialStorePath({ _tag: "LoginSlot" }, fixture.configDir),
			);
		expect(
			(await fixture.requestRpc({ _tag: "GetStatus" })).port,
		).toBeGreaterThan(0);
		if (replay) await fixture.requestRpc({ _tag: "GetCursorAuth", accountId });
		await fixture.terminate();
		expect(
			observations().filter(({ phase }) => phase.startsWith("sdk-")),
		).toEqual([]);
	});

	it.each([
		false,
		true,
	])("serves with Cursor unavailable when loading fails, adopted=%s", async (adopted) => {
		const fixture = await start(`failed-${adopted}`, {
			cursor: true,
			adopted,
			failLoad: true,
		});
		const beforeRpc = observations();
		expect(
			(await fixture.requestRpc({ _tag: "GetStatus" })).port,
		).toBeGreaterThan(0);
		const browser = await fixture.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		const cursor = (await browser.instances()).instances.find(
			({ id }) => id === accountId,
		);
		evidence["cursor"] = cursor;
		expect(cursor).toMatchObject({
			available: false,
			unavailableReason: "Cursor SDK could not load",
		});
		expect(beforeRpc.some(({ phase }) => phase === "sdk-load-started")).toBe(
			true,
		);
		expect(beforeRpc.some(({ phase }) => phase === "sdk-load-finished")).toBe(
			false,
		);
	});

	it("never imports the SDK in CLI commands while Cursor is configured", async () => {
		const fixture = await start("cli", { cursor: true, adopted: true });
		for (const args of [["--help"], ["status"]]) {
			const result = await fixture.runCli(args, { timeoutMs: 60_000 });
			expect(result.code, result.output).toBe(0);
			expect(
				observations().filter(
					({ phase, pid }) => phase.startsWith("sdk-") && pid === result.pid,
				),
			).toEqual([]);
		}
	});
});
