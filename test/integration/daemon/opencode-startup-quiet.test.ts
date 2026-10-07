import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultInstanceIdForDriver } from "../../../src/lib/contracts/provider-instance.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

// Failure cases: daemon or relay startup or browser attach spawning or probing
// OpenCode, the first OpenCode session spawning twice or not at all, a
// reachable external server being replaced by a spawned one, a restart
// spawning a second process next to the survivor, and a survivor's pending
// prompts and busy sessions staying invisible until someone uses OpenCode.
describe("Managed OpenCode starts on first use", () => {
	const instanceId = defaultInstanceIdForDriver("opencode");
	let harness: ProcessHarness | undefined;
	let scenario = "setup";
	let evidence: Record<string, unknown> = {};

	function start(name: string, autoStartOpenCode = true) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.7", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode,
		});
		return harness;
	}

	/** Lines of a fake OpenCode JSONL log under `configDir`. */
	function fakeLog<T>(configDir: string, name: string): T[] {
		const file = join(configDir, `fake-opencode-${name}.jsonl`);
		return existsSync(file)
			? readFileSync(file, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as T)
			: [];
	}

	/** Every fake OpenCode process the daemon ever started. */
	const spawned = (fixture: ProcessHarness) =>
		fakeLog<{ pid: number }>(fixture.configDir, "pids");

	function persistedStatus(fixture: ProcessHarness, sessionId: string) {
		const db = new Database(fixture.projectStorePath(), { readonly: true });
		try {
			const row = db
				.prepare("SELECT status FROM sessions WHERE id = ?")
				.get(sessionId) as { status: string } | undefined;
			return row?.status;
		} finally {
			db.close();
		}
	}

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			await fixture.terminate();
			evidence["spawned"] = spawned(fixture);
			evidence["requests"] = fixture.opencodeRequests();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/pa3r-7-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("spawns nothing at startup or attach, then exactly once for the first OpenCode session", async () => {
		const fixture = start("first-use");
		await fixture.restart();
		// connect() returns after the PTY snapshot. A
		// sessionless attach sends nothing after that (the model, effort and
		// context window ride shell rows and GetModels since ni8.55), so the
		// quiet window below is what covers the rest of the attach.
		const browser = await fixture.connect();
		await new Promise<void>((done) => setTimeout(done, 1500));
		const idle = {
			spawned: spawned(fixture).length,
			ownedProcesses: fixture.ownedOpenCodePids().length,
			requests: fixture.opencodeRequests(),
			status: (await browser.instanceStatus(instanceId)).instance?.status,
		};
		evidence["startupAndAttach"] = idle;
		expect(idle).toEqual({
			spawned: 0,
			ownedProcesses: 0,
			requests: [],
			status: "stopped",
		});

		const sessionId = await browser.createSession(
			"OpenCode",
			instanceId,
			"opencode",
		);
		const models = await browser.getModels();
		const firstUse = {
			sessionId,
			spawned: spawned(fixture).length,
			status: (await browser.instanceStatus(instanceId)).instance?.status,
			providers: models.providers.map(({ id, models }) => ({
				id,
				models: models.map((model) => model.id),
			})),
		};
		evidence["firstUse"] = firstUse;
		expect(firstUse.spawned).toBe(1);
		expect(firstUse.status).toBe("healthy");
		expect(firstUse.providers).toContainEqual({
			id: "fake",
			models: ["fake-model"],
		});

		await browser.stopInstance(instanceId);
		const stopped = (await browser.instanceStatus(instanceId)).instance?.status;
		await browser.startInstance(instanceId);
		await vi.waitFor(
			async () =>
				expect(
					(await browser.instanceStatus(instanceId)).instance?.status,
				).toBe("healthy"),
			{ timeout: 10_000 },
		);
		const afterRestart = await browser.getModels();
		evidence["startStop"] = {
			stopped,
			spawnsAfter: spawned(fixture).length,
			providersAfter: afterRestart.providers.map(({ id }) => id),
		};
		expect(stopped).toBe("stopped");
		expect(spawned(fixture)).toHaveLength(2);
		expect(afterRestart.providers.map(({ id }) => id)).toContain("fake");
	}, 90_000);

	it("uses a reachable external server at the default URL and spawns nothing", async () => {
		const fixture = start("external", false);
		// The fake OpenCode, started outside the daemon with its own logs.
		const externalRoot = join(fixture.root, "external");
		const externalConfig = join(externalRoot, "config");
		mkdirSync(externalConfig, { recursive: true });
		mkdirSync(join(externalRoot, "home"));
		const server = spawn(
			join(fixture.root, "bin", "opencode"),
			["serve", "--port=0"],
			{
				env: {
					PATH: process.env["PATH"],
					CONDUIT_CONFIG_DIR: externalConfig,
					HOME: join(externalRoot, "home"),
				},
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		try {
			const [line] = (await once(server.stdout, "data")) as [Buffer];
			const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line.toString())?.[0];
			if (!url) throw new Error(`No external OpenCode URL in ${line}`);
			await fixture.restart({ opencodeUrl: url });
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"External",
				instanceId,
				"opencode",
			);
			await vi.waitFor(
				async () =>
					expect(
						(await browser.instanceStatus(instanceId)).instance?.status,
					).toBe("healthy"),
				{ timeout: 10_000 },
			);
			const instance = (await browser.instanceStatus(instanceId)).instance;
			const external = {
				sessionId,
				managed: instance?.managed,
				status: instance?.status,
				spawned: spawned(fixture).length,
				ownedProcesses: fixture.ownedOpenCodePids().length,
				url: instance?.url,
				externalRequests: fakeLog<{ method: string; url: string }>(
					externalConfig,
					"requests",
				).map(({ method, url }) => `${method} ${url}`),
			};
			evidence["external"] = external;
			expect(external).toMatchObject({
				managed: false,
				status: "healthy",
				spawned: 0,
				ownedProcesses: 0,
				url,
			});
			expect(external.externalRequests).toContain("POST /session");
		} finally {
			for (const { childPid } of fakeLog<{ childPid: number }>(
				externalConfig,
				"pids",
			))
				process.kill(childPid, "SIGKILL");
			server.kill("SIGKILL");
		}
	}, 90_000);

	it("starts a managed default whose configured port is busy on another port, then prompts and replies through it", async () => {
		const fixture = start("dynamic-port");
		const squatterRequests: string[] = [];
		const squatter = createServer((request, response) => {
			squatterRequests.push(`${request.method} ${request.url}`);
			response.writeHead(500).end();
		});
		squatter.listen(0, "127.0.0.1");
		await once(squatter, "listening");
		try {
			const address = squatter.address();
			if (!address || typeof address === "string")
				throw new Error("No squatter port");
			const configuredPort = address.port;
			const configFile = join(fixture.configDir, "daemon.json");
			const config = JSON.parse(readFileSync(configFile, "utf8"));
			writeFileSync(
				configFile,
				JSON.stringify({
					...config,
					instances: [
						{
							id: instanceId,
							name: "Default OpenCode",
							port: configuredPort,
							managed: true,
							driver: "opencode",
						},
					],
				}),
			);
			await fixture.restart();
			const browser = await fixture.connect();
			const sessionId = await browser.createSession(
				"Dynamic port",
				undefined,
				"opencode",
			);
			const started = (await browser.instanceStatus(instanceId)).instance;
			const reply = await browser.send(sessionId, "hello");
			await fixture.addOpenCodePrompt("permission", fixture.projectDir, {
				id: "pa7-dynamic-port",
				sessionID: sessionId,
				permission: "bash",
				patterns: ["echo dynamic"],
				metadata: {},
				always: [],
			});
			const permission = await browser.waitFor(
				(message) =>
					message["type"] === "permission_pending" &&
					message["requestId"] === "pa7-dynamic-port",
			);
			await browser.answerApproval(permission, "allow");
			const replyPath = `/session/${sessionId}/permissions/pa7-dynamic-port`;
			await vi.waitFor(
				() =>
					expect(
						fixture
							.opencodeRequests()
							.some(
								({ method, url }) =>
									method === "POST" && url.split("?")[0] === replyPath,
							),
					).toBe(true),
				{ timeout: 10_000 },
			);
			// The fake drops a pending permission only when an authenticated reply reaches it.
			const state = JSON.parse(
				readFileSync(
					join(fixture.configDir, "fake-opencode-state.json"),
					"utf8",
				),
			) as { permissions: Record<string, unknown[]> };
			const dynamic = {
				configuredPort,
				actualPort: started?.port,
				status: started?.status,
				spawnCount: spawned(fixture).length,
				promptDone: reply.done,
				pendingPermissionsAfterReply: Object.values(state.permissions).flat(),
				squatterRequests,
				fakeRequests: fixture.opencodeRequests(),
			};
			evidence["dynamicPort"] = dynamic;
			expect(dynamic.spawnCount).toBe(1);
			expect(dynamic.status).toBe("healthy");
			expect(dynamic.actualPort).not.toBe(configuredPort);
			expect(dynamic.promptDone["code"]).toBe(0);
			expect(
				dynamic.fakeRequests.filter(
					({ method, url }) =>
						method === "POST" &&
						url.split("?")[0] === `/session/${sessionId}/prompt_async`,
				),
			).toHaveLength(1);
			expect(dynamic.pendingPermissionsAfterReply).toEqual([]);
			expect(squatterRequests).toEqual([]);
		} finally {
			squatter.close();
		}
	}, 90_000);

	it("re-adopts a survivor without a second spawn and recovers its prompts and busy sessions unprompted", async () => {
		const fixture = start("re-adoption");
		await fixture.restart();
		const first = await fixture.connect();
		const sessionId = await first.createSession(
			"Survivor",
			instanceId,
			"opencode",
		);
		await first.close();
		await fixture.terminate();
		const survivor = spawned(fixture);
		expect(survivor).toHaveLength(1);

		// Created while no daemon runs, so only reconcile can deliver them.
		await fixture.setOpenCodeStatus(fixture.projectDir, sessionId, {
			type: "busy",
		});
		await fixture.addOpenCodePrompt("permission", fixture.projectDir, {
			id: "pa7-readopt",
			sessionID: sessionId,
			permission: "bash",
			patterns: ["echo readopt"],
			metadata: {},
			always: [],
		});

		await fixture.restart();
		const browser = await fixture.connect();
		const permission = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === "pa7-readopt",
		);
		await vi.waitFor(
			() => expect(persistedStatus(fixture, sessionId)).toBe("busy"),
			{ timeout: 15_000 },
		);
		const readopted = {
			sessionId,
			survivorPid: survivor[0]?.pid,
			spawned: spawned(fixture).map(({ pid }) => pid),
			status: (await browser.instanceStatus(instanceId)).instance?.status,
			permission,
			sessionStatus: persistedStatus(fixture, sessionId),
			streamConnections: fixture.opencodeStreamConnections(),
		};
		evidence["readopted"] = readopted;
		expect(readopted.spawned).toEqual([survivor[0]?.pid]);
		expect(readopted.status).toBe("healthy");
	}, 90_000);
});
