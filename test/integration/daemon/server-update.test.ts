import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
	AddProject,
	RemoveProject,
	SetPin,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { testRunnerAlive } from "../../helpers/claude-runner-cleanup.js";
import {
	type BrowserFrame,
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Run after building: CONDUIT_TEST_DIST=dist npx --no-install vitest run
// --config vitest.integration.config.ts test/integration/daemon/server-update.test.ts
// Failure cases: a partial/matching/missing build offers restart; foreground
// offers restart; clients miss transitions or connect with stale status; browser
// RPC cannot restart the daemon; restart kills or replaces independent runners.
const DIST = resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist");
const { BUILD_ID } = (await import(
	pathToFileURL(join(DIST, "src/lib/build-id.js")).href
)) as typeof import("../../../src/lib/build-id.js");
// Allow scheduling overhead around the five-second polling interval.
const POLL_TIMEOUT_MS = 6500;
const EXPECTED_SCENARIOS = 10;

describe("supervised server build updates", () => {
	let harness: ProcessHarness | undefined;
	let markerPath: string;
	const sockets = new Set<WebSocket>();
	const scenarios: Array<Record<string, unknown>> = [];
	const cleanup: Array<Record<string, unknown>> = [];

	async function start(
		mode: "service" | "legacy" | "foreground" | "service-disabled",
		marker?: string,
		buildId?: string,
	) {
		harness = ProcessHarness.create({
			dist: DIST,
			foregroundCli: true,
			restartProof: true,
		});
		markerPath = join(harness.root, "build-ready.json");
		if (marker !== undefined) writeFileSync(markerPath, marker);
		const serviceEnvironment = {
			CONDUIT_BUILD_READY_PATH: markerPath,
			...(buildId !== undefined ? { CONDUIT_SERVER_BUILD_ID: buildId } : {}),
			...(mode === "service" ? { CONDUIT_SERVICE: "1" } : {}),
			...(mode === "service-disabled" ? { CONDUIT_SERVICE: "0" } : {}),
			...(mode === "legacy" ? { XPC_SERVICE_NAME: "dev.conduit.server" } : {}),
		};
		await harness.restart({ serviceEnvironment });
		const generation = harness.generations[0];
		if (!generation) throw new Error("Isolated server generation is missing");
		expect(generation.port).not.toBe(2633);
		expect(harness.configDir.startsWith(`${harness.root}/`)).toBe(true);
		return { harness, generation, serviceEnvironment };
	}

	async function status(
		browser: { frames: BrowserFrame[] },
		restartAvailable: boolean,
		cursor = 0,
	) {
		let found: BrowserFrame | undefined;
		await vi.waitFor(
			() => {
				found = browser.frames
					.slice(cursor)
					.find(
						({ message }) =>
							message["type"] === "server_update" &&
							message["restartAvailable"] === restartAvailable,
					);
				expect(found).toBeDefined();
			},
			{ timeout: POLL_TIMEOUT_MS, interval: 20 },
		);
		if (!found) throw new Error("Expected server_update was not received");
		return {
			message: found.message,
			at: found.at.toString(),
			index: browser.frames.indexOf(found),
		};
	}

	async function initialStatus(
		browser: { frames: BrowserFrame[] },
		restartAvailable: boolean,
		buildId = BUILD_ID,
	) {
		const update = await status(browser, restartAvailable);
		const protocolIndex = browser.frames.findIndex(
			({ message }) => message["type"] === "protocol_version",
		);
		expect(protocolIndex).toBeGreaterThanOrEqual(0);
		expect(browser.frames[protocolIndex]?.message["buildId"]).toBe(buildId);
		expect(update.index).toBe(protocolIndex + 1);
		return { protocolIndex, ...update };
	}

	afterEach(async (context) => {
		for (const socket of sockets) socket.terminate();
		sockets.clear();
		if (!harness) return;
		const owned = harness;
		const pids = new Set([
			...owned.generations.map((generation) => generation.pid),
			...owned.runnerPids(),
			...owned.ownedOpenCodePids(),
			...owned.cliPids,
		]);
		let verified = false;
		let remaining: string[] = [];
		let processTable: { available: boolean; error?: string } = {
			available: false,
		};
		try {
			await owned.dispose();
			await vi.waitFor(
				() => expect([...pids].filter(testRunnerAlive)).toEqual([]),
				{ timeout: 5000 },
			);
			try {
				remaining = execFileSync("ps", ["-axo", "pid,command"], {
					encoding: "utf8",
					maxBuffer: 8 * 1024 * 1024,
					stdio: ["ignore", "pipe", "pipe"],
				})
					.split("\n")
					.filter((line) => {
						const pid = Number(line.trim().split(/\s+/, 1)[0]);
						return pids.has(pid) || line.includes(owned.root);
					});
				processTable = { available: true };
			} catch (cause) {
				processTable = {
					available: false,
					error: cause instanceof Error ? cause.message : String(cause),
				};
			}
			expect(remaining).toEqual([]);
			expect(existsSync(owned.root)).toBe(false);
			verified = true;
		} finally {
			cleanup.push({
				test: context.task.name,
				root: owned.root,
				configDir: owned.configDir,
				pids: [...pids],
				remainingPids: [...pids].filter(testRunnerAlive),
				remaining,
				processTable,
				verified,
				passed: context.task.result?.state !== "fail",
				proof: owned.proof(),
			});
			harness = undefined;
		}
	});

	afterAll(() => {
		mkdirSync("test-results", { recursive: true });
		writeFileSync(
			"test-results/ohdt-server-update.json",
			JSON.stringify(
				{
					ticket: "conduit-test-ohdt",
					dist: DIST,
					buildId: BUILD_ID,
					expectedScenarios: EXPECTED_SCENARIOS,
					passed:
						scenarios.length === EXPECTED_SCENARIOS &&
						cleanup.length === EXPECTED_SCENARIOS &&
						cleanup.every((entry) => entry["passed"] && entry["verified"]),
					scenarios,
					cleanup,
				},
				null,
				2,
			),
		);
	});

	it("pushes build changes to both projects and late clients, then clears stale status", async () => {
		const { harness: owned, generation } = await start("service");
		const first = await owned.connect();
		const firstInitial = await initialStatus(first, false);
		const directory = join(owned.root, "second-project");
		mkdirSync(directory);
		const added = await sendRpcRequest(
			join(owned.configDir, "relay.sock"),
			new AddProject({ directory }),
		);
		if (!added.addedSlug) throw new Error("Second project was not registered");
		const second = await owned.connect(undefined, undefined, added.addedSlug);
		const secondInitial = await initialStatus(second, false);
		const transitions: Array<Record<string, unknown>> = [];

		async function transition(marker: string | undefined, available: boolean) {
			const firstCursor = first.frames.length;
			const secondCursor = second.frames.length;
			const started = process.hrtime.bigint();
			if (marker === undefined) rmSync(markerPath);
			else writeFileSync(markerPath, marker);
			const [firstUpdate, secondUpdate] = await Promise.all([
				status(first, available, firstCursor),
				status(second, available, secondCursor),
			]);
			expect(first.connected && second.connected).toBe(true);
			transitions.push({
				marker: marker ?? "missing",
				available,
				firstUpdate,
				secondUpdate,
				elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
			});
		}

		await transition(JSON.stringify({ buildId: randomUUID() }), true);
		const late = await owned.connect(undefined, undefined, added.addedSlug);
		const lateInitial = await initialStatus(late, true);
		await transition(JSON.stringify({ buildId: BUILD_ID }), false);
		await transition(JSON.stringify({ buildId: randomUUID() }), true);
		await transition(JSON.stringify({ buildId: 42 }), false);
		await transition(JSON.stringify({ buildId: randomUUID() }), true);
		await transition(undefined, false);
		scenarios.push({
			scenario: "project broadcast and marker transitions",
			generation,
			projectSlugs: ["process-test", added.addedSlug],
			firstInitial,
			secondInitial,
			lateInitial,
			transitions,
		});
	}, 70_000);

	it("sends the current update status to a late browser with no registered projects", async () => {
		const { harness: owned, generation } = await start("service");
		const projectBrowser = await owned.connect();
		const projectInitial = await initialStatus(projectBrowser, false);
		const cursor = projectBrowser.frames.length;
		writeFileSync(markerPath, JSON.stringify({ buildId: randomUUID() }));
		const projectUpdate = await status(projectBrowser, true, cursor);
		await projectBrowser.close();
		const removed = await sendRpcRequest(
			join(owned.configDir, "relay.sock"),
			new RemoveProject({ slug: "process-test" }),
		);
		expect(removed.projects).toEqual([]);

		const frames: BrowserFrame[] = [];
		const browserUrl = `ws://127.0.0.1:${generation.port}/ws`;
		const ws = new WebSocket(browserUrl);
		sockets.add(ws);
		ws.on("message", (data) => {
			frames.push({
				message: JSON.parse(data.toString()) as Record<string, unknown>,
				at: process.hrtime.bigint(),
			});
		});
		ws.on("error", () => {});
		const lateInitial = await initialStatus({ frames }, true);
		expect(ws.readyState).toBe(WebSocket.OPEN);
		scenarios.push({
			scenario: "late browser without projects",
			generation,
			browserUrl,
			projectInitial,
			projectUpdate,
			registeredProjects: removed.projects,
			lateInitial,
		});
	}, 30_000);

	it.each([
		"missing",
		"same build",
		"invalid JSON",
	] as const)("starts with no restart available for a %s marker", async (initialMarker) => {
		const marker =
			initialMarker === "same build"
				? JSON.stringify({ buildId: BUILD_ID })
				: initialMarker === "invalid JSON"
					? "{unfinished-build"
					: undefined;
		const { harness: owned, generation } = await start("service", marker);
		const browser = await owned.connect();
		const initial = await initialStatus(browser, false);
		scenarios.push({
			scenario: "initial marker",
			initialMarker,
			initial,
			generation,
		});
	});

	it.each([
		"foreground",
		"service-disabled",
	] as const)("never offers restart for a newer build in %s mode", async (mode) => {
		const marker = JSON.stringify({ buildId: randomUUID() });
		const { harness: owned, generation } = await start(mode, marker);
		const browser = await owned.connect();
		const initial = await initialStatus(browser, false);
		const cursor = browser.frames.length;
		writeFileSync(markerPath, JSON.stringify({ buildId: randomUUID() }));
		await new Promise<void>((done) => setTimeout(done, 5500));
		expect(
			browser.frames
				.slice(cursor)
				.filter(
					({ message }) =>
						message["type"] === "server_update" &&
						message["restartAvailable"] === true,
				),
		).toEqual([]);
		expect(browser.connected).toBe(true);
		scenarios.push({
			scenario: "unsupervised newer build",
			mode,
			initial,
			generation,
		});
	}, 30_000);

	it("recognizes the legacy launchd service environment", async () => {
		const { harness: owned, generation } = await start(
			"legacy",
			JSON.stringify({ buildId: randomUUID() }),
		);
		const browser = await owned.connect();
		const initial = await initialStatus(browser, true);
		scenarios.push({ scenario: "legacy service", generation, initial });
	});

	it("does not offer restart when the running build is the dev sentinel", async () => {
		const { harness: owned, generation } = await start(
			"service",
			JSON.stringify({ buildId: randomUUID() }),
			"dev",
		);
		const browser = await owned.connect();
		const initial = await initialStatus(browser, false, "dev");
		await new Promise<void>((done) => setTimeout(done, 5500));
		expect(
			browser.frames.filter(
				({ message }) =>
					message["type"] === "server_update" &&
					message["restartAvailable"] === true,
			),
		).toEqual([]);
		scenarios.push({ scenario: "dev build", generation, initial });
	}, 30_000);

	it("restarts through an authenticated project browser and re-adopts the live Claude runner", async () => {
		const {
			harness: owned,
			generation,
			serviceEnvironment,
		} = await start("service");
		const browser = await owned.connect();
		await initialStatus(browser, false);
		const sessionId = await browser.createSession("server update restart");
		const prompt = "before-build-restart";
		expect((await browser.send(sessionId, prompt)).chunks).toEqual(
			responseChunks(prompt),
		);
		const runner = owned.marks.find(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (runner?.kind !== "runner-started")
			throw new Error("Claude runner is missing");
		expect(testRunnerAlive(runner.pid)).toBe(true);
		const query = owned.marks.find((mark) => mark.kind === "query");
		if (query?.kind !== "query") throw new Error("Fake SDK query is missing");
		const pin = "482615";
		await sendRpcRequest(
			join(owned.configDir, "relay.sock"),
			new SetPin({ pin }),
		);
		await browser.close();

		const originId = randomUUID();
		const frames: BrowserFrame[] = [];
		const projectUrl = `ws://127.0.0.1:${generation.port}/ws?p=process-test&client=${originId}`;
		const ws = new WebSocket(projectUrl, { headers: { "x-relay-pin": pin } });
		sockets.add(ws);
		ws.on("message", (data) => {
			frames.push({
				message: JSON.parse(data.toString()) as Record<string, unknown>,
				at: process.hrtime.bigint(),
			});
		});
		ws.on("error", () => {});
		await initialStatus({ frames }, false);
		const cursor = frames.length;
		writeFileSync(markerPath, JSON.stringify({ buildId: randomUUID() }));
		const update = await status({ frames }, true, cursor);

		const rpcUrl = `ws://127.0.0.1:${generation.port}/rpc`;
		const protocol = RpcClient.layerProtocolSocket().pipe(
			Layer.provide(Socket.layerWebSocket(rpcUrl)),
			Layer.provide(
				Layer.succeed(
					Socket.WebSocketConstructor,
					(url) =>
						new WebSocket(url, {
							headers: { "x-relay-pin": pin },
						}) as unknown as globalThis.WebSocket,
				),
			),
			Layer.provide(RpcSerialization.layerJson),
		);
		const restarted = await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const client = yield* RpcClient.make(WsRpcGroup);
					yield* client.AttachProject({
						projectSlug: "process-test",
						originId,
					});
					return yield* client.RestartWithConfig({});
				}),
			).pipe(Effect.provide(protocol), Effect.timeout(10_000)),
		);
		expect(restarted).toEqual({ ok: true });
		ws.terminate();
		sockets.delete(ws);
		await owned.waitForExit({ keepBrowsersOpen: true });
		expect(generation.exitCode).toBe(0);
		expect(generation.signal).toBeNull();
		expect(testRunnerAlive(generation.pid)).toBe(false);
		expect(testRunnerAlive(runner.pid)).toBe(true);
		const readProof = () =>
			readFileSync(join(owned.root, "sdk-proof.ndjson"), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(
			readProof().filter(
				(mark) =>
					mark["kind"] === "query-closed" && mark["queryId"] === query.queryId,
			),
		).toEqual([]);

		writeFileSync(markerPath, JSON.stringify({ buildId: BUILD_ID }));
		await owned.restart({ serviceEnvironment, skipBrowserProbe: true });
		const replacement = owned.generations[1];
		if (!replacement)
			throw new Error("Replacement server generation is missing");
		await sendRpcRequest(
			join(owned.configDir, "relay.sock"),
			new SetPin({ pin: null }),
		);
		const reconnected = await owned.connect(sessionId);
		await vi.waitFor(() => expect(replacement.fakeSdkActive).toBe(true), {
			timeout: 2000,
		});
		const replacementInitial = await initialStatus(reconnected, false);
		const afterPrompt = "after-build-restart";
		expect((await reconnected.send(sessionId, afterPrompt)).chunks).toEqual(
			responseChunks(afterPrompt),
		);
		expect(owned.runnerPids()).toEqual([runner.pid]);
		expect(readProof().filter((mark) => mark["kind"] === "query")).toHaveLength(
			1,
		);
		scenarios.push({
			scenario: "authenticated browser restart and runner re-adoption",
			projectUrl,
			rpcUrl,
			pinRequired: true,
			generation,
			replacement,
			runner,
			queryId: query.queryId,
			update,
			replacementInitial,
			proof: readProof(),
		});
	}, 60_000);
});
