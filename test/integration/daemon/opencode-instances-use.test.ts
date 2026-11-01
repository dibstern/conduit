import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect, Result as Either, Option, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openCodeStartSelection } from "../../../src/lib/contracts/start-selection.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { findFreePort } from "../../../src/lib/daemon/daemon-utils.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure cases: a project receiving another instance's events, a prompt
// reaching the wrong instance, and `use` on an unreachable instance hanging
// instead of failing at the browser.
describe("OpenCode Instances use", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "routing";
	let evidence: Record<string, unknown> = {};

	async function start(name: string, defaultAccountId?: string) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.5", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			managedOpenCode: true,
			managedOpenCodeId: "opencode",
		});
		const config = Either.getOrThrow(loadDaemonConfigResult(harness.configDir));
		const managed = config?.instances?.find(({ id }) => id === "opencode");
		if (!config || !managed)
			throw new Error("Missing managed OpenCode fixture");
		// Concrete servers need separate fake stores as well as separate processes.
		writeFileSync(
			join(harness.configDir, "daemon.json"),
			JSON.stringify({
				...config,
				...(defaultAccountId
					? {
							accountDefaults: {
								...config.accountDefaults,
								opencode: defaultAccountId,
							},
						}
					: {}),
				instances: [
					...(config.instances ?? []),
					{
						...managed,
						id: "managed-test",
						name: "Named test",
						env: {
							...managed.env,
							CONDUIT_TEST_OPENCODE_STATE_PREFIX: "named",
						},
					},
				],
			}),
		);
		await harness.restart();
		return harness;
	}

	const sessionIdentity = (fixture: ProcessHarness, sessionId: string) => {
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			const identity = db
				.prepare(
					`SELECT s.id AS sessionId, s.provider_sid AS providerSessionId,
					 sp.provider AS accountId, sp.provider_sid AS bindingProviderSessionId,
					 COALESCE(s.provider_sid, s.id) AS nativeSessionId
					 FROM sessions s JOIN session_providers sp ON sp.session_id = s.id
					 WHERE s.id = ? AND sp.status = 'active'`,
				)
				.get(sessionId) as
				| {
						sessionId: string;
						providerSessionId: string | null;
						accountId: string;
						bindingProviderSessionId: string | null;
						nativeSessionId: string;
				  }
				| undefined;
			if (!identity) throw new Error(`Missing OpenCode session ${sessionId}`);
			expect(identity.nativeSessionId).toBe(sessionId);
			expect(identity.bindingProviderSessionId).toBeNull();
			return identity;
		} finally {
			db.close();
		}
	};

	const permission = (id: string, sessionID: string) => ({
		id: `evt_${id}`,
		type: "permission.asked",
		properties: {
			id,
			sessionID,
			permission: "bash",
			patterns: ["echo instances-use"],
			metadata: {},
			always: [],
		},
	});

	const requests = (browser: ProcessBrowser, id: string) =>
		browser.frames.filter(
			({ message }) =>
				message["type"] === "permission_pending" &&
				message["requestId"] === harness?.promptIdForProviderRequest(id),
		).length;

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		try {
			evidence["providerRequests"] = fixture
				.opencodeRequests()
				.filter(
					({ url }) => url.startsWith("/session") && !url.includes("/message"),
				);
			await fixture.terminate();
			evidence["streamConnections"] = fixture.opencodeStreamConnections();
			evidence["failures"] =
				task.result?.errors?.map(({ message }) => message) ?? [];
		} finally {
			try {
				await fixture.dispose();
				fixture.assertNoRunners();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/${scenario.startsWith("rqbc-2-") ? scenario : `pa3r-5-${scenario}`}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("health-polls a saved external default after restart before its first use", async () => {
		const fixture = await start("external-default");
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
				detached: true,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		try {
			const [line] = (await once(server.stdout, "data")) as [Buffer];
			const url = /http:\/\/127\.0\.0\.1:\d+/.exec(line.toString())?.[0];
			if (!url) throw new Error(`No external OpenCode URL in ${line}`);
			const { addedInstanceId } = await fixture.requestRpc({
				_tag: "AddInstance",
				name: "External default",
				driver: "opencode",
				managed: false,
				port: Number(new URL(url).port),
				url,
			});
			if (!addedInstanceId) throw new Error("Missing external instance id");
			await fixture.requestRpc({
				_tag: "SetDefault",
				instanceId: addedInstanceId,
			});
			await fixture.terminate();
			await fixture.restart({ skipBrowserProbe: true });
			const browser = await fixture.connect();
			const snapshot = Option.getOrThrow(
				await Effect.runPromise(
					browser.rpc.SubscribeInstances({}).pipe(
						Stream.filter(({ instances }) =>
							instances.some(
								(instance) =>
									instance.id === addedInstanceId &&
									instance.status === "healthy",
							),
						),
						Stream.runHead,
					),
				),
			);
			expect(snapshot.instances).toContainEqual(
				expect.objectContaining({
					id: addedInstanceId,
					managed: false,
					isDefault: true,
					status: "healthy",
				}),
			);
			const sessionId = await browser.createSession(
				"External default draft",
				undefined,
				"opencode",
			);
			expect(sessionIdentity(fixture, sessionId).accountId).toBe(
				addedInstanceId,
			);
			evidence["externalDefault"] = {
				url,
				addedInstanceId,
				sessionId,
				snapshot,
			};
		} finally {
			if (server.pid) process.kill(-server.pid, "SIGKILL");
		}
	});

	it("routes events and prompts through each session's selected instance", async () => {
		const fixture = await start("routing");
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, {
			_tag: "GetInstances",
		});
		const instanceA = instances.find(({ id }) => id === "opencode");
		const { addedInstanceId: instanceBId } = await sendRpcRequest(socket, {
			_tag: "AddInstance",
			name: "Other OpenCode",
			driver: "opencode",
			managed: true,
			port: await findFreePort(0),
			env: { CONDUIT_TEST_OPENCODE_STATE_PREFIX: "other" },
		});
		if (!instanceA || !instanceBId)
			throw new Error("Expected two OpenCode instances");
		// Exercise the concrete managed account alongside the named accounts.
		const pidOf = (id: string) => {
			const pid = Either.getOrThrowWith(
				loadDaemonConfigResult(fixture.configDir),
				(error) => error,
			)?.instances?.find((instance) => instance.id === id)?.pid;
			if (!pid) throw new Error(`No pid for OpenCode instance ${id}`);
			return pid;
		};
		const a = await fixture.connect();
		const sessionA = await a.createSession(
			"Default A",
			instanceA.id,
			"opencode",
		);
		const directoryB = join(fixture.root, "project-b");
		mkdirSync(directoryB, { recursive: true });
		const { savedSlug: slugB } = await sendRpcRequest(socket, {
			_tag: "SaveProject",
			folders: [directoryB],
		});
		const b = await fixture.connect(undefined, undefined, slugB);
		// Each session's first use spawns its selected instance.
		const sessionB = await b.createSession("Named B", instanceBId, "opencode");
		const pids = {
			a: pidOf(instanceA.id),
			b: pidOf(instanceBId),
		};
		evidence["instances"] = {
			a: { id: instanceA.id, pid: pids.a },
			b: { id: instanceBId, pid: pids.b },
		};
		const identityA = sessionIdentity(fixture, sessionA);
		const identityB = sessionIdentity(fixture, sessionB);
		expect(identityA.accountId).toBe(instanceA.id);
		expect(identityB.accountId).toBe(instanceBId);
		evidence["sessions"] = { a: identityA, b: identityB };

		// Prompt before any permission prompt is open: the session inbox holds
		// queued input while a prompt waits on the user.
		// The fake accepts prompts without streaming a reply, so `done` never
		// arrives; the recorded request is the observable.
		void a.send(sessionA, "prompt for A").catch(() => undefined);
		void b.send(sessionB, "prompt for B").catch(() => undefined);
		const prompts = () =>
			fixture
				.opencodeRequestBodies()
				.filter(({ path }) => /^\/session\/[^/]+\/prompt/.test(path))
				.map((request) => ({
					path: request.path,
					pid: "pid" in request ? request.pid : undefined,
				}))
				.map(({ pid, path }) => ({
					instance: pid === pids.a ? "a" : pid === pids.b ? "b" : String(pid),
					session: path.split("/")[2],
				}));
		await vi.waitFor(() => expect(prompts()).toHaveLength(2), {
			timeout: 15_000,
		});
		evidence["prompts"] = prompts();
		expect(prompts()).toEqual(
			expect.arrayContaining([
				{ instance: "a", session: sessionA },
				{ instance: "b", session: sessionB },
			]),
		);

		// Cross-instance events first; the own-instance events after them are
		// the processing barrier for the isolation assertions.
		await fixture.emitOpenCodeEvent(
			{ directory: directoryB, payload: permission("cross-b", sessionB) },
			instanceA.id,
		);
		await fixture.emitOpenCodeEvent(
			{
				directory: fixture.projectDir,
				payload: permission("cross-a", sessionA),
			},
			instanceBId,
		);
		await fixture.emitOpenCodeEvent(
			{ directory: fixture.projectDir, payload: permission("own-a", sessionA) },
			instanceA.id,
		);
		await fixture.emitOpenCodeEvent(
			{ directory: directoryB, payload: permission("own-b", sessionB) },
			instanceBId,
		);
		await a.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"own-a",
		);
		await b.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"own-b",
		);
		const events = {
			a: { own: requests(a, "own-a"), cross: requests(a, "cross-a") },
			b: { own: requests(b, "own-b"), cross: requests(b, "cross-b") },
		};
		evidence["routedEventCounts"] = events;
		expect(events).toEqual({
			a: { own: 1, cross: 0 },
			b: { own: 1, cross: 0 },
		});
	}, 90_000);

	it("uses the saved named OpenCode default and falls back to managed during its outage", async () => {
		const fixture = await start("named-default-outage", "managed-test");
		evidence["ticket"] = "conduit-test-3fc0.7";
		const browser = await fixture.connect();
		await browser.startInstance("managed-test");
		await browser.startInstance("opencode");
		const accounts = (await browser.instances()).instances;
		const selected = accounts.find(({ id }) => id === "managed-test");
		const managed = accounts.find(({ id }) => id === "opencode");
		if (!selected?.pid || !managed?.pid)
			throw new Error("Missing selected or managed OpenCode process");
		expect(selected).toMatchObject({ isDefault: true, status: "healthy" });
		expect(managed).toMatchObject({ isDefault: false, status: "healthy" });
		expect(selected.pid).not.toBe(managed.pid);
		expect(selected.port).not.toBe(managed.port);
		evidence["accounts"] = [selected, managed];
		await Effect.runPromise(
			browser.rpc.SetDefaultModel({
				projectSlug: "process-test",
				provider: "fake",
				model: "fake-model",
			}),
		);
		const deliveries: Record<string, unknown>[] = [];
		evidence["deliveries"] = deliveries;
		const sendDefault = async (
			accountId: string,
			pid: number,
			text: string,
		) => {
			const snapshot = (await browser.instances()).instances;
			expect(
				openCodeStartSelection(
					snapshot,
					new Map(snapshot.map(({ id, status }) => [id, status])),
				).account.id,
			).toBe(accountId);
			const catalogCursor = fixture.opencodeRequests().length;
			const catalog = await browser.getModels();
			expect(catalog.providers.some((provider) => provider.id === "fake")).toBe(
				true,
			);
			const catalogRequests = fixture
				.opencodeRequests()
				.slice(catalogCursor)
				.filter(
					(request) =>
						request.method === "GET" &&
						request.url.split("?")[0] === "/provider",
				);
			expect(catalogRequests.length).toBeGreaterThan(0);
			expect(catalogRequests.every((request) => request.pid === pid)).toBe(
				true,
			);
			const agentCursor = fixture.opencodeRequests().length;
			await Effect.runPromise(
				browser.rpc.GetAgents({ projectSlug: "process-test" }),
			);
			const agentRequests = fixture
				.opencodeRequests()
				.slice(agentCursor)
				.filter(
					(request) =>
						request.method === "GET" && request.url.split("?")[0] === "/agent",
				);
			expect(agentRequests.length).toBeGreaterThan(0);
			expect(agentRequests.every((request) => request.pid === pid)).toBe(true);
			const sessionId = await browser.createSession(
				text,
				undefined,
				"opencode",
			);
			const identity = sessionIdentity(fixture, sessionId);
			expect(identity.accountId).toBe(accountId);
			void browser.send(sessionId, text).catch(() => undefined);
			const path = `/session/${identity.nativeSessionId}/prompt_async`;
			const received = () =>
				fixture
					.opencodeRequestBodies()
					.find(
						(request) =>
							request.method === "POST" &&
							request.path === path &&
							request.body.includes(text),
					);
			await vi.waitFor(() => expect(received()).toMatchObject({ pid, path }), {
				timeout: 15_000,
			});
			deliveries.push({
				...identity,
				catalogPids: catalogRequests.map((request) => request.pid),
				agentPids: agentRequests.map((request) => request.pid),
				expectedPid: pid,
				receivingPid: received()?.pid,
				path,
			});
		};
		await sendDefault(selected.id, selected.pid, "named default prompt");
		await browser.stopInstance(selected.id);
		await sendDefault(
			managed.id,
			managed.pid,
			"managed outage fallback prompt",
		);
		const saved = Either.getOrThrow(loadDaemonConfigResult(fixture.configDir));
		expect(saved?.accountDefaults?.opencode).toBe(selected.id);
		expect(
			(await browser.instances()).instances.find(
				({ id }) => id === selected.id,
			),
		).toMatchObject({ isDefault: true, status: "stopped" });
		evidence["savedDefault"] = saved?.accountDefaults?.opencode;
	}, 90_000);

	it("delivers a persisted session's live permission from non-selected instance B after restart without using B", async () => {
		const fixture = await start("rqbc-2-non-selected-instance");
		evidence["ticket"] = "conduit-test-rqbc.2";
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, {
			_tag: "GetInstances",
		});
		const instanceA = instances.find(
			({ id, driver }) => driver === "opencode" && id === "opencode",
		);
		const instanceB = instances.find(
			({ id, driver }) => driver === "opencode" && id === "managed-test",
		);
		if (!instanceA || !instanceB)
			throw new Error("Expected two OpenCode instances");
		const first = await fixture.connect();
		const sessionB = await first.createSession(
			"Persisted on B",
			instanceB.id,
			"opencode",
		);
		const pidB = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === instanceB.id)?.pid;
		expect(pidB).toBeTypeOf("number");
		const db = new Database(fixture.daemonStorePath(), { readonly: true });
		try {
			expect(
				db
					.prepare(
						"SELECT provider FROM session_providers WHERE session_id = ? AND status = 'active'",
					)
					.get(sessionB),
			).toEqual({ provider: instanceB.id });
		} finally {
			db.close();
		}
		await first.close();
		await fixture.terminate();
		const streamCursor = fixture.opencodeStreamConnections().length;
		await fixture.restart({ skipBrowserProbe: true });
		await vi.waitFor(() =>
			expect(
				fixture
					.opencodeStreamConnections()
					.slice(streamCursor)
					.some(({ action, pid }) => action === "open" && pid === pidB),
			).toBe(true),
		);
		const browser = await fixture.connect();
		// A live-only ask cannot be recovered by /permission polling. Browsing
		// recreates the relay, but no create/send/answer/start may use B.
		await fixture.emitOpenCodeEvent(
			{
				directory: fixture.projectDir,
				payload: permission("rqbc-2-live-on-b", sessionB),
			},
			instanceB.id,
		);
		const delivered = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
					"rqbc-2-live-on-b",
		);
		const recovered = new Database(fixture.daemonStorePath(), {
			readonly: true,
		});
		try {
			const approval = recovered
				.prepare(
					"SELECT id, session_id, status FROM pending_approvals WHERE provider_request_id = ?",
				)
				.get("rqbc-2-live-on-b");
			evidence["recovered"] = {
				selectedInstance: instanceA.id,
				boundInstance: instanceB.id,
				pidB,
				sessionB,
				delivered,
				approval,
			};
			expect(approval).toEqual({
				id: fixture.promptIdForProviderRequest("rqbc-2-live-on-b"),
				session_id: sessionB,
				status: "pending",
			});
		} finally {
			recovered.close();
		}
		expect(
			Either.getOrThrowWith(
				loadDaemonConfigResult(fixture.configDir),
				(error) => error,
			)?.projects.find(({ slug }) => slug === "process-test"),
		).not.toHaveProperty("instanceId");
	}, 90_000);

	it("recovers a downtime permission on non-selected B before grace expiry without a browser", async () => {
		const fixture = await start("rqbc-2-non-selected-recovery");
		evidence["ticket"] = "conduit-test-rqbc.2";
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, {
			_tag: "GetInstances",
		});
		const instanceA = instances.find(
			({ id, driver }) => driver === "opencode" && id === "opencode",
		);
		const instanceB = instances.find(
			({ id, driver }) => driver === "opencode" && id === "managed-test",
		);
		if (!instanceA || !instanceB)
			throw new Error("Expected two OpenCode instances");
		const first = await fixture.connect();
		await first.createSession("Selected A", instanceA.id, "opencode");
		const sessionB = await first.createSession(
			"Busy on B",
			instanceB.id,
			"opencode",
		);
		await fixture.setOpenCodeStatus(
			fixture.projectDir,
			sessionB,
			{ type: "busy" },
			instanceB.id,
		);
		await vi.waitFor(() => {
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				expect(
					db.prepare("SELECT status FROM sessions WHERE id = ?").get(sessionB),
				).toEqual({ status: "busy" });
			} finally {
				db.close();
			}
		});
		await first.close();
		await fixture.terminate();
		const id = "rqbc-2-downtime-on-b";
		await fixture.addOpenCodePrompt(
			"permission",
			fixture.projectDir,
			permission(id, sessionB).properties,
			instanceB.id,
		);
		const graceMs = 60_000;
		const restartedAt = Date.now();
		await fixture.restart({
			skipBrowserProbe: true,
			opencodeIdleTimeoutMs: graceMs,
		});
		await vi.waitFor(
			() => {
				const db = new Database(fixture.daemonStorePath(), { readonly: true });
				try {
					const approval = db
						.prepare(
							"SELECT id, session_id, status FROM pending_approvals WHERE provider_request_id = ?",
						)
						.get(id);
					expect(approval).toEqual({
						id: fixture.promptIdForProviderRequest(id),
						session_id: sessionB,
						status: "pending",
					});
					evidence["recoveredBeforeAttach"] = {
						selectedInstance: instanceA.id,
						boundInstance: instanceB.id,
						elapsedMs: Date.now() - restartedAt,
						graceMs,
						approval,
					};
				} finally {
					db.close();
				}
			},
			{ timeout: 5_000 },
		);
		expect(Date.now() - restartedAt).toBeLessThan(graceMs);
		const browser = await fixture.connect();
		evidence["delivered"] = await browser.waitFor(
			(message) =>
				message["type"] === "permission_pending" &&
				fixture.providerRequestIdForPrompt(String(message["requestId"])) === id,
		);
	}, 90_000);

	it("surfaces start on an unreachable instance as a browser error", async () => {
		const fixture = await start("unreachable");
		const socket = join(fixture.configDir, "relay.sock");
		const closedPort = await new Promise<number>((done, fail) => {
			const server = createServer();
			server.once("error", fail);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				server.close(() =>
					typeof address === "object" && address
						? done(address.port)
						: fail(new Error("No port")),
				);
			});
		});
		const { instances } = await sendRpcRequest(socket, {
			_tag: "AddInstance",
			name: "Unreachable",
			driver: "opencode",
			managed: false,
			url: `http://127.0.0.1:${closedPort}`,
		});
		const unreachable = instances.find(({ name }) => name === "Unreachable");
		if (!unreachable) throw new Error("Unreachable instance was not added");
		const a = await fixture.connect();
		const startedAt = Date.now();
		const error = await a.startInstance(unreachable.id).then(
			() => undefined,
			(cause: unknown) => cause,
		);
		const elapsedMs = Date.now() - startedAt;
		const message =
			error instanceof Error
				? error.message
				: JSON.stringify(error ?? "no error");
		evidence["unreachable"] = {
			instanceId: unreachable.id,
			url: `http://127.0.0.1:${closedPort}`,
			elapsedMs,
			message,
		};
		expect(error).toBeDefined();
		// Explicit start preserves the connection's actionable cause.
		expect(message).toContain(unreachable.id);
		expect(message).toContain(`http://127.0.0.1:${closedPort}`);
		expect(message).toContain("unreachable");
		expect(message).toMatch(/refused|fetch failed|connect|ECONNREFUSED/i);
		expect(message).not.toContain("Timeout");
		expect(elapsedMs).toBeLessThan(15_000);
		// The browser socket is still usable after the failure.
		await a.createSession("Still works", "opencode", "opencode");
	}, 90_000);
});
