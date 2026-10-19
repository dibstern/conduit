import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AddInstance,
	GetInstances,
	SaveProject,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
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

	async function start(name: string) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.5", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			managedOpenCode: true,
		});
		await harness.restart();
		return harness;
	}

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

	it("routes events and prompts through each session's selected instance", async () => {
		const fixture = await start("routing");
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, new GetInstances({}));
		const [instanceA, instanceB] = instances.filter(
			({ driver }) => driver === "opencode",
		);
		if (!instanceA || !instanceB)
			throw new Error("Expected two OpenCode instances");
		// Session A uses the first OpenCode instance; session B selects the other.
		const pidOf = (id: string) => {
			const pid = Either.getOrThrowWith(
				loadDaemonConfigResult(fixture.configDir),
				(error) => error,
			)?.instances?.find((instance) => instance.id === id)?.pid;
			if (!pid) throw new Error(`No pid for OpenCode instance ${id}`);
			return pid;
		};
		const a = await fixture.connect();
		const sessionA = await a.createSession("Default A", "opencode", "opencode");
		const directoryB = join(fixture.root, "project-b");
		mkdirSync(directoryB, { recursive: true });
		const { savedSlug: slugB } = await sendRpcRequest(
			socket,
			new SaveProject({ folders: [directoryB] }),
		);
		const b = await fixture.connect(undefined, undefined, slugB);
		// Each session's first use spawns its selected instance.
		const sessionB = await b.createSession("Named B", instanceB.id, "opencode");
		const pids = {
			a: pidOf(instanceA.id),
			b: pidOf(instanceB.id),
		};
		evidence["instances"] = {
			a: { id: instanceA.id, pid: pids.a },
			b: { id: instanceB.id, pid: pids.b },
		};
		evidence["sessions"] = { sessionA, sessionB };

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
			instanceB.id,
		);
		await fixture.emitOpenCodeEvent(
			{ directory: fixture.projectDir, payload: permission("own-a", sessionA) },
			instanceA.id,
		);
		await fixture.emitOpenCodeEvent(
			{ directory: directoryB, payload: permission("own-b", sessionB) },
			instanceB.id,
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

	it("delivers a persisted session's live permission from non-selected instance B after restart without using B", async () => {
		const fixture = await start("rqbc-2-non-selected-instance");
		evidence["ticket"] = "conduit-test-rqbc.2";
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, new GetInstances({}));
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
		const { instances } = await sendRpcRequest(socket, new GetInstances({}));
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
		const { instances } = await sendRpcRequest(
			socket,
			new AddInstance({
				name: "Unreachable",
				driver: "opencode",
				managed: false,
				url: `http://127.0.0.1:${closedPort}`,
			}),
		);
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
