import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GetInstances,
	RemoveProject,
	SaveProject,
	SetProjectInstance,
	StartInstance,
	UpdateInstance,
} from "../../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../../helpers/process-harness.js";

// Failure cases: one connection per relay, cross-directory delivery, path
// aliases missing events, malformed frames killing the stream, late subscribers
// missing connection state, and leaked subscriptions after project removal.
describe("daemon shared OpenCode global stream", () => {
	let harness: ProcessHarness | undefined;
	let scenario = "routing";
	let evidence: Record<string, unknown> = {};

	async function start(name: string, managedOpenCode = false) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.3", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			managedOpenCode,
		});
		await harness.restart();
		return harness;
	}

	async function addProject(fixture: ProcessHarness, directory: string) {
		mkdirSync(directory, { recursive: true });
		const result = await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new SaveProject({ folders: [directory] }),
		);
		return result.savedSlug;
	}

	async function removeProject(fixture: ProcessHarness, slug: string) {
		await sendRpcRequest(
			join(fixture.configDir, "relay.sock"),
			new RemoveProject({ slug }),
		);
	}

	function requests(browser: ProcessBrowser, prefix: string) {
		return browser.frames.filter(
			({ message }) =>
				message["type"] === "permission_pending" &&
				String(message["requestId"]).startsWith(prefix),
		).length;
	}

	const permission = (id: string, sessionID: string) => ({
		id: `evt_${id}`,
		type: "permission.asked",
		properties: {
			id,
			sessionID,
			permission: "bash",
			patterns: ["echo shared-stream"],
			metadata: {},
			always: [],
		},
	});

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
					`test-results/pa3r-3-${scenario}.json`,
					JSON.stringify({ ...evidence, process: fixture.proof() }, null, 2),
				);
				harness = undefined;
			}
		}
	});

	it("shares one global connection and routes only by normalized directory", async () => {
		const fixture = await start("routing");
		const a = await fixture.connect();
		const sessionA = await a.createSession("Project A", "opencode", "opencode");
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession("Project B", "opencode", "opencode");
		evidence["sessions"] = { sessionA, sessionB };
		evidence["directories"] = [fixture.projectDir, directoryB];
		await vi.waitFor(() => {
			expect(
				fixture
					.opencodeStreamConnections()
					.filter(({ action }) => action === "open"),
			).toEqual([expect.objectContaining({ path: "/global/event" })]);
		});
		// The misleading project field must not influence routing. /tmp and
		// /private/tmp aliases must refer to the same subscribed directory.
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(fixture.projectDir),
			project: slugB,
			payload: permission("pa3r-a-1", sessionA),
		});
		await a.waitFor((message) => message["requestId"] === "pa3r-a-1");
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(directoryB),
			project: "process-test",
			payload: permission("pa3r-b-1", sessionB),
		});
		await b.waitFor((message) => message["requestId"] === "pa3r-b-1");
		await fixture.emitOpenCodeEvent({ payload: null });
		await fixture.emitOpenCodeEvent({
			directory: directoryB,
			payload: { type: 42 },
		});
		await fixture.emitOpenCodeEvent({
			directory: "global",
			project: "process-test",
			payload: permission("pa3r-global", sessionA),
		});
		const unsubscribed = join(fixture.root, "unsubscribed");
		mkdirSync(unsubscribed);
		await fixture.emitOpenCodeEvent({
			directory: unsubscribed,
			payload: permission("pa3r-unsubscribed", sessionA),
		});
		// Valid events after bad frames are the processing barrier for the
		// isolation assertions, rather than an arbitrary sleep.
		await fixture.emitOpenCodeEvent({
			directory: fixture.projectDir,
			payload: permission("pa3r-a-2", sessionA),
		});
		await fixture.emitOpenCodeEvent({
			directory: directoryB,
			payload: permission("pa3r-b-2", sessionB),
		});
		await a.waitFor((message) => message["requestId"] === "pa3r-a-2");
		await b.waitFor((message) => message["requestId"] === "pa3r-b-2");
		const counts = {
			a: { a: requests(a, "pa3r-a-"), b: requests(a, "pa3r-b-") },
			b: { a: requests(b, "pa3r-a-"), b: requests(b, "pa3r-b-") },
			dropped:
				requests(a, "pa3r-global") +
				requests(b, "pa3r-global") +
				requests(a, "pa3r-unsubscribed") +
				requests(b, "pa3r-unsubscribed"),
		};
		evidence["routedEventCounts"] = counts;
		expect(counts).toEqual({
			a: { a: 2, b: 0 },
			b: { a: 0, b: 2 },
			dropped: 0,
		});
		expect(
			fixture
				.opencodeStreamConnections()
				.filter(({ action }) => action === "open"),
		).toEqual([expect.objectContaining({ path: "/global/event" })]);
	}, 90_000);

	it("keeps a project's selected OpenCode instance separate from the daemon default", async () => {
		const fixture = await start("project-instance", true);
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, new GetInstances({}));
		const opencode = instances.filter(({ driver }) => driver === "opencode");
		expect(opencode).toHaveLength(2);
		const [defaultInstance, namedInstance] = opencode;
		if (!defaultInstance || !namedInstance)
			throw new Error("Expected two OpenCode instances");
		const defaultId = defaultInstance.id;
		const namedId = namedInstance.id;
		const a = await fixture.connect();
		const sessionA = await a.createSession("Default A", "opencode", "opencode");
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		await sendRpcRequest(
			socket,
			new SetProjectInstance({ slug: slugB, instanceId: namedId }),
		);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession(
			"Selected B",
			"opencode",
			"opencode",
		);
		await vi.waitFor(() => {
			expect(
				fixture
					.opencodeStreamConnections()
					.filter(({ action }) => action === "open"),
			).toHaveLength(2);
		});
		await fixture.emitOpenCodeEvent(
			{
				directory: directoryB,
				payload: permission("pa3r-selected-b", sessionB),
			},
			namedId,
		);
		await b.waitFor((message) => message["requestId"] === "pa3r-selected-b");
		await fixture.emitOpenCodeEvent(
			{
				directory: fixture.projectDir,
				payload: permission("pa3r-default-a", sessionA),
			},
			defaultId,
		);
		await a.waitFor((message) => message["requestId"] === "pa3r-default-a");
		const counts = {
			a: {
				own: requests(a, "pa3r-default-a"),
				other: requests(a, "pa3r-selected-b"),
			},
			b: {
				own: requests(b, "pa3r-selected-b"),
				other: requests(b, "pa3r-default-a"),
			},
		};
		evidence["routedEventCounts"] = counts;
		expect(counts).toEqual({
			a: { own: 1, other: 0 },
			b: { own: 1, other: 0 },
		});
		expect(
			fixture
				.opencodeStreamConnections()
				.filter(({ path }) => path === "/event"),
		).toHaveLength(0);
	}, 90_000);

	it("refreshes the shared transport for a new relay after the default endpoint changes", async () => {
		const fixture = await start("endpoint-change", true);
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, new GetInstances({}));
		const opencode = instances.filter(({ driver }) => driver === "opencode");
		expect(opencode).toHaveLength(2);
		const [defaultInstance, namedInstance] = opencode;
		if (!defaultInstance || !namedInstance)
			throw new Error("Expected two OpenCode instances");
		const defaultId = defaultInstance.id;
		// Managed OpenCode spawns on first use; the replacement must be running.
		// That use opens its stream, which the default relay's subscription
		// keeps open, so count connections after it.
		await sendRpcRequest(
			socket,
			new StartInstance({ instanceId: namedInstance.id }),
		);
		const connectionsAfterStart = fixture.opencodeStreamConnections().length;
		const replacement = loadDaemonConfig(fixture.configDir)?.instances?.find(
			({ id }) => id === namedInstance.id,
		);
		expect(replacement?.port).toBeGreaterThan(0);
		if (!replacement) throw new Error("Replacement OpenCode instance missing");
		const a = await fixture.connect();
		await a.createSession("Existing A", "opencode", "opencode");
		await sendRpcRequest(
			socket,
			new UpdateInstance({
				instanceId: defaultId,
				port: replacement.port,
				env: replacement.env,
			}),
		);
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession("Fresh B", "opencode", "opencode");
		// Session creation uses REST; wait separately for the replacement SSE
		// connection before asking the fake to emit a non-replayed event.
		await vi.waitFor(() => {
			expect(
				fixture
					.opencodeStreamConnections()
					.slice(connectionsAfterStart)
					.filter(({ action }) => action === "open"),
			).toHaveLength(2);
		});
		evidence["endpoints"] = loadDaemonConfig(fixture.configDir)?.instances?.map(
			({ id, port, pid }) => ({ id, port, pid }),
		);
		evidence["endpointChange"] = {
			instanceId: defaultId,
			from: defaultInstance.port,
			to: replacement.port,
		};
		// Emit through the replacement's unchanged ownership record, rather
		// than relying on persistence of the edited default instance's port.
		await fixture.emitOpenCodeEvent(
			{ directory: directoryB, payload: permission("pa3r-fresh-b", sessionB) },
			replacement.id,
		);
		await b.waitFor((message) => message["requestId"] === "pa3r-fresh-b");
		evidence["routedEventCounts"] = { b: requests(b, "pa3r-fresh-b") };
		expect(requests(b, "pa3r-fresh-b")).toBe(1);
		await vi.waitFor(() => {
			const connections = fixture
				.opencodeStreamConnections()
				.slice(connectionsAfterStart);
			expect(
				connections.filter(({ action }) => action === "open"),
			).toHaveLength(2);
			expect(
				connections.filter(({ action }) => action === "close"),
			).toHaveLength(1);
			expect(connections.every(({ path }) => path === "/global/event")).toBe(
				true,
			);
		});
	}, 90_000);

	it("keeps the stream until the last relay closes and reopens for a new scope", async () => {
		const fixture = await start("scopes");
		const a = await fixture.connect();
		await a.createSession("Scoped A", "opencode", "opencode");
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		await b.createSession("Scoped B", "opencode", "opencode");
		await a.close();
		await removeProject(fixture, "process-test");
		expect(
			fixture
				.opencodeStreamConnections()
				.filter(({ action }) => action === "close"),
		).toHaveLength(0);
		const cursor = b.frames.length;
		await fixture.closeOpenCodeStreams();
		await b.waitFor(
			(message) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "opencodeConnection" &&
				message["status"] === "disconnected",
			cursor,
		);
		await b.waitFor(
			(message) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "opencodeConnection" &&
				message["status"] === "reconnecting",
			cursor,
		);
		await b.waitFor(
			(message) =>
				message["type"] === "project_setting" &&
				message["_tag"] === "opencodeConnection" &&
				message["status"] === "connected",
			cursor,
		);
		await b.close();
		await removeProject(fixture, slugB);
		await vi.waitFor(() => {
			const connections = fixture.opencodeStreamConnections();
			expect(
				connections.filter(({ action }) => action === "open"),
			).toHaveLength(2);
			expect(
				connections.filter(({ action }) => action === "close"),
			).toHaveLength(2);
		});
		const reopenedSlug = await addProject(fixture, directoryB);
		const reopened = await fixture.connect(undefined, undefined, reopenedSlug);
		await reopened.createSession("Reopened", "opencode", "opencode");
		await vi.waitFor(() => {
			expect(
				fixture
					.opencodeStreamConnections()
					.filter(({ action }) => action === "open"),
			).toHaveLength(3);
		});
		evidence["connectionStates"] = b.frames
			.map(({ message }) => message)
			.filter((message) => message["_tag"] === "opencodeConnection");
	}, 90_000);
});
