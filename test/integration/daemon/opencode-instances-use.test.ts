import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AddInstance,
	GetInstances,
	SaveProject,
	SetProjectInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
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
				message["type"] === "permission_request" && message["requestId"] === id,
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
					`test-results/pa3r-5-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("routes each project's events and prompts only through its own instance", async () => {
		const fixture = await start("routing");
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, new GetInstances({}));
		const [instanceA, instanceB] = instances.filter(
			({ driver }) => driver === "opencode",
		);
		if (!instanceA || !instanceB)
			throw new Error("Expected two OpenCode instances");
		// Project A keeps the daemon default (the first instance); B selects the other.
		const pidOf = (id: string) => {
			const pid = loadDaemonConfig(fixture.configDir)?.instances?.find(
				(instance) => instance.id === id,
			)?.pid;
			if (!pid) throw new Error(`No pid for OpenCode instance ${id}`);
			return pid;
		};
		const pids = {
			a: pidOf(instanceA.id),
			b: pidOf(instanceB.id),
		};
		const a = await fixture.connect();
		const sessionA = await a.createSession("Default A", undefined, "opencode");
		const directoryB = join(fixture.root, "project-b");
		mkdirSync(directoryB, { recursive: true });
		const { savedSlug: slugB } = await sendRpcRequest(
			socket,
			new SaveProject({ folders: [directoryB] }),
		);
		await sendRpcRequest(
			socket,
			new SetProjectInstance({ slug: slugB, instanceId: instanceB.id }),
		);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession("Named B", undefined, "opencode");
		evidence["instances"] = {
			a: { id: instanceA.id, pid: pids.a },
			b: { id: instanceB.id, pid: pids.b },
		};
		evidence["sessions"] = { sessionA, sessionB };

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
		await a.waitFor((message) => message["requestId"] === "own-a");
		await b.waitFor((message) => message["requestId"] === "own-b");
		const events = {
			a: { own: requests(a, "own-a"), cross: requests(a, "cross-a") },
			b: { own: requests(b, "own-b"), cross: requests(b, "cross-b") },
		};
		evidence["routedEventCounts"] = events;
		expect(events).toEqual({
			a: { own: 1, cross: 0 },
			b: { own: 1, cross: 0 },
		});

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
	}, 90_000);

	it("surfaces use on an unreachable instance as a browser error", async () => {
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
		const error = await a
			.createSession("Unreachable", unreachable.id, "opencode")
			.then(
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
		// The relay wraps the tagged OpenCodeUnavailable in SessionManagerError;
		// the browser sees the operation failure, not a timeout.
		expect(message).toContain("CreateSession failed");
		expect(message).not.toContain("Timeout");
		expect(elapsedMs).toBeLessThan(15_000);
		// The browser socket is still usable after the failure.
		await a.createSession("Still works", undefined, "opencode");
	}, 90_000);
});
