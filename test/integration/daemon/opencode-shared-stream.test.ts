import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Result as Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
} from "../../../src/lib/daemon/config-persistence.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
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

	async function start(
		name: string,
		managedOpenCode = false,
		opencodeIdleTimeoutMs?: number,
	) {
		scenario = name;
		evidence = { ticket: "conduit-test-pa3r.3", at: new Date().toISOString() };
		harness = ProcessHarness.create({
			dist: resolve(process.env["CONDUIT_TEST_DIST"] ?? "dist"),
			foregroundCli: true,
			autoStartOpenCode: true,
			managedOpenCode,
		});
		const serviceEnvironment = {
			CONDUIT_SERVICE: "0",
			CONDUIT_TEST_HEALTH_POLL_INTERVAL_MS: "100",
			CONDUIT_TEST_OPENCODE_STATUS_POLL_INTERVAL_MS: "300",
		};
		await harness.restart({
			...(opencodeIdleTimeoutMs === undefined ? {} : { opencodeIdleTimeoutMs }),
			serviceEnvironment,
		});
		return harness;
	}

	async function addProject(fixture: ProcessHarness, directory: string) {
		mkdirSync(directory, { recursive: true });
		const result = await sendRpcRequest(join(fixture.configDir, "relay.sock"), {
			_tag: "SaveProject",
			folders: [directory],
		});
		return result.savedSlug;
	}

	async function removeProject(fixture: ProcessHarness, slug: string) {
		await sendRpcRequest(join(fixture.configDir, "relay.sock"), {
			_tag: "RemoveProject",
			slug,
		});
	}

	function requests(browser: ProcessBrowser, prefix: string) {
		return browser.frames.filter(
			({ message }) =>
				message["type"] === "permission_pending" &&
				(
					harness?.providerRequestIdForPrompt(String(message["requestId"])) ??
					""
				).startsWith(prefix),
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
					`test-results/${scenario.startsWith("directory-removal-") ? "rqbc-2" : "pa3r-3"}-${scenario}.json`,
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
		await a.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-a-1",
		);
		await fixture.emitOpenCodeEvent({
			directory: realpathSync(directoryB),
			project: "process-test",
			payload: permission("pa3r-b-1", sessionB),
		});
		await b.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-b-1",
		);
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
		await a.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-a-2",
		);
		await b.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-b-2",
		);
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

	it("backfills an unseen native session from its first worktree idle event", async () => {
		scenario = "first-sighting-backfill";
		evidence = { ticket: "conduit-test-82tn.7" };
		// Source mode exercises the current relay without relying on a prior build.
		const fixture = ProcessHarness.create();
		harness = fixture;
		const worktree = join(fixture.root, "native-worktree");
		mkdirSync(worktree);
		const nativeSession = "ses_native_first_sighting";
		const nativeMessage = "msg_native_first_sighting";
		const sessionInfo = (id: string, directory: string) => ({
			id,
			slug: "native-history",
			version: "1",
			projectID: "native-project",
			directory,
			title: "Native history session",
			time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 },
		});
		const history = [
			{
				info: {
					id: nativeMessage,
					sessionID: nativeSession,
					role: "user",
					time: { created: 1_700_000_000_000 },
					agent: "build",
					model: { providerID: "openai", modelID: "gpt-4" },
				},
				parts: [
					{
						id: "prt_native_first_sighting",
						sessionID: nativeSession,
						messageID: nativeMessage,
						type: "text",
						text: "NATIVE_WORKTREE_HISTORY",
					},
				],
			},
		];
		const server = new MockOpenCodeServer(
			loadOpenCodeRecording("chat-simple"),
			true,
		);
		const historyDirectories: string[] = [];
		const historyResponses: number[] = [];
		const artifact: Record<string, unknown> = {
			ticket: "conduit-test-82tn.7",
			scenario: "first-sighting-backfill",
			event: { session: "session-2", directory: "<W1>", status: "idle" },
		};
		const readNative = () => {
			if (!existsSync(fixture.daemonStorePath()))
				return { session: undefined, messages: [] };
			const db = new Database(fixture.daemonStorePath(), { readonly: true });
			try {
				return {
					session: db
						.prepare("SELECT history_complete FROM sessions WHERE id = ?")
						.get(nativeSession),
					messages: db
						.prepare(
							"SELECT role, text FROM messages WHERE session_id = ? ORDER BY created_at, id",
						)
						.all(nativeSession),
				};
			} finally {
				db.close();
			}
		};
		const proxy = createServer((incoming, outgoing) => {
			const url = new URL(incoming.url ?? "/", server.url);
			if (url.pathname === `/session/${nativeSession}/message`) {
				const header = incoming.headers["x-opencode-directory"];
				const directory =
					url.searchParams.get("directory") ??
					(typeof header === "string" ? decodeURIComponent(header) : "");
				historyDirectories.push(directory);
				const responseStatus =
					directory !== worktree
						? 409
						: historyDirectories.length === 1
							? 503
							: 200;
				historyResponses.push(responseStatus);
				outgoing.writeHead(responseStatus, {
					"Content-Type": "application/json",
				});
				outgoing.end(
					JSON.stringify(
						responseStatus === 200
							? history
							: { message: "Native history unavailable for this request" },
					),
				);
				return;
			}
			const upstream = request(
				url,
				{ method: incoming.method, headers: incoming.headers },
				(response) => {
					outgoing.writeHead(response.statusCode ?? 500, response.headers);
					response.pipe(outgoing);
				},
			);
			upstream.on("error", (error) => outgoing.destroy(error));
			outgoing.on("close", () => upstream.destroy());
			incoming.pipe(upstream);
		});
		try {
			await server.start();
			server.setExactResponse("GET", "/session", 200, []);
			server.setExactResponse("GET", "/provider", 200, {
				all: [
					{
						id: "fake",
						name: "Fake",
						models: {
							"fake-model": {
								id: "fake-model",
								name: "Fake",
								limit: { context: 128000, output: 4096 },
							},
						},
					},
				],
				default: { fake: "fake-model" },
				connected: ["fake"],
			});
			server.setExactResponse(
				"GET",
				`/session/${nativeSession}`,
				200,
				sessionInfo(nativeSession, worktree),
			);
			server.setExactResponse(
				"POST",
				"/session",
				200,
				sessionInfo("ses_subscribed_worktree", fixture.projectDir),
			);
			server.setExactResponse(
				"GET",
				"/session/ses_subscribed_worktree/message",
				200,
				[],
			);
			await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
			const address = proxy.address();
			if (!address || typeof address === "string")
				throw new Error("No history proxy port");
			writeFileSync(
				join(fixture.configDir, "daemon.json"),
				JSON.stringify({
					...defaultDaemonConfig(),
					instances: [
						{
							id: "opencode",
							name: "Native history",
							driver: "opencode",
							managed: false,
							url: `http://127.0.0.1:${address.port}`,
							port: address.port,
						},
					],
				}),
			);
			await fixture.restart({ startupTimeoutMs: 60_000 });
			const firstBrowser = await fixture.connect();
			const subscriber = await firstBrowser.createSession(
				"Worktree subscriber",
				"opencode",
				"opencode",
			);
			await fixture.terminate();
			const db = new Database(fixture.daemonStorePath());
			try {
				db.prepare("UPDATE sessions SET workspace = ? WHERE id = ?").run(
					JSON.stringify({
						cause: "user",
						origin: "existing",
						worktrees: { [fixture.projectDir]: worktree },
					}),
					subscriber,
				);
			} finally {
				db.close();
			}
			await fixture.restart({ startupTimeoutMs: 60_000 });
			const browser = await fixture.connect();
			server.setExactResponse(
				"POST",
				"/session",
				200,
				sessionInfo("ses_root_peer", fixture.projectDir),
			);
			server.setExactResponse("GET", "/session/ses_root_peer/message", 200, []);
			await browser.createSession("Root peer", "opencode", "opencode");
			await vi.waitFor(() =>
				expect(
					server.diagnostics.filter(({ event }) => event === "sse_connect")
						.length,
				).toBeGreaterThan(1),
			);
			artifact["before"] = readNative();
			expect(readNative().session).toBeUndefined();
			// This direct provider read only gives the mock the native directory; it
			// does not introduce the session to Conduit's store or event pipeline.
			await fetch(
				`${server.url}/session/${nativeSession}?directory=${encodeURIComponent(worktree)}`,
			);
			server.emitTestEvent("session.status", {
				sessionID: nativeSession,
				status: { type: "idle" },
			});
			await vi.waitFor(
				() =>
					expect(readNative()).toEqual({
						session: { history_complete: 1 },
						messages: [{ role: "user", text: "NATIVE_WORKTREE_HISTORY" }],
					}),
				{ timeout: 10_000 },
			);
			expect(historyDirectories.length).toBeGreaterThanOrEqual(2);
			expect(historyResponses[0]).toBe(503);
			expect(
				historyDirectories.every((directory) => directory === worktree),
			).toBe(true);
		} finally {
			artifact["historyResponses"] = historyResponses;
			artifact["historyDirectories"] = historyDirectories.map((directory) =>
				directory === worktree
					? "<W1>"
					: directory.replaceAll(fixture.root, "<ROOT>"),
			);
			artifact["after"] = readNative();
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn7-first-sighting-backfill.json",
				JSON.stringify(artifact, null, 2),
			);
			await fixture.terminate();
			await server.stop();
			proxy.closeAllConnections();
			await new Promise<void>((done) => proxy.close(() => done()));
		}
	}, 180_000);

	it("keeps a session's selected OpenCode instance separate from the daemon default", async () => {
		const fixture = await start("project-instance", true);
		const socket = join(fixture.configDir, "relay.sock");
		const { instances } = await sendRpcRequest(socket, {
			_tag: "GetInstances",
		});
		const opencode = instances.filter(({ driver }) => driver === "opencode");
		expect(opencode).toHaveLength(2);
		const defaultInstance = opencode.find(({ id }) => id === "managed-test");
		if (!defaultInstance) throw new Error("Expected the managed test instance");
		const defaultId = defaultInstance.id;
		const { addedInstanceId: namedId } = await sendRpcRequest(socket, {
			_tag: "AddInstance",
			name: "Selected B",
			driver: "opencode",
			managed: true,
			port: 0,
		});
		if (!namedId) throw new Error("Expected a new named OpenCode instance");
		expect(namedId).not.toBe(defaultId);
		const a = await fixture.connect();
		const sessionA = await a.createSession("Default A", defaultId, "opencode");
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		const sessionB = await b.createSession("Selected B", namedId, "opencode");
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
		await b.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-selected-b",
		);
		await fixture.emitOpenCodeEvent(
			{
				directory: fixture.projectDir,
				payload: permission("pa3r-default-a", sessionA),
			},
			defaultId,
		);
		await a.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-default-a",
		);
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
		const { instances } = await sendRpcRequest(socket, {
			_tag: "GetInstances",
		});
		const opencode = instances.filter(({ driver }) => driver === "opencode");
		expect(opencode).toHaveLength(2);
		const [defaultInstance, namedInstance] = opencode;
		if (!defaultInstance || !namedInstance)
			throw new Error("Expected two OpenCode instances");
		const defaultId = defaultInstance.id;
		// Managed OpenCode spawns on first use; the replacement must be running.
		// That use opens its stream, which stays open through the idle grace,
		// so count connections after it.
		await sendRpcRequest(socket, {
			_tag: "StartInstance",
			instanceId: namedInstance.id,
		});
		const connectionsAfterStart = fixture.opencodeStreamConnections().length;
		const replacement = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.find(({ id }) => id === namedInstance.id);
		expect(replacement?.port).toBeGreaterThan(0);
		if (!replacement) throw new Error("Replacement OpenCode instance missing");
		const a = await fixture.connect();
		await a.createSession("Existing A", "opencode", "opencode");
		await sendRpcRequest(socket, {
			_tag: "UpdateInstance",
			instanceId: defaultId,
			port: replacement.port,
			env: replacement.env,
		});
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
		evidence["endpoints"] = Either.getOrThrowWith(
			loadDaemonConfigResult(fixture.configDir),
			(error) => error,
		)?.instances?.map(({ id, port, pid }) => ({ id, port, pid }));
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
		await b.waitFor(
			(message) =>
				fixture.providerRequestIdForPrompt(String(message["requestId"])) ===
				"pa3r-fresh-b",
		);
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

	it.each([
		"busy",
		"permission",
		"question",
	] as const)("drops a removed directory's %s demand and lets the shared instance idle-stop", async (kind) => {
		const graceMs = 1_000;
		const fixture = await start(`directory-removal-${kind}`, false, graceMs);
		evidence["ticket"] = "conduit-test-rqbc.2";
		const a = await fixture.connect();
		const sessionA = await a.createSession("Removed A", "opencode", "opencode");
		await a.view(sessionA);
		await a.followSessions();
		if (kind === "busy") {
			await fixture.setOpenCodeStatus(fixture.projectDir, sessionA, {
				type: "busy",
			});
			await a.waitFor(
				(message) =>
					message["type"] === "session_row" &&
					message["id"] === sessionA &&
					message["status"] === "busy",
			);
		} else {
			const id = `rqbc-2-removed-${kind}`;
			await fixture.addOpenCodePrompt(kind, fixture.projectDir, {
				id,
				sessionID: sessionA,
				...(kind === "permission"
					? {
							permission: "bash",
							patterns: ["echo removed"],
							metadata: {},
							always: [],
						}
					: {
							questions: [
								{
									question: "Proceed?",
									header: "Proceed",
									options: [{ label: "Yes" }],
								},
							],
						}),
			});
			await a.waitFor(
				(message) =>
					message["type"] === `${kind}_pending` &&
					fixture.providerRequestIdForPrompt(
						String(message[kind === "permission" ? "requestId" : "toolId"]),
					) === id,
			);
		}
		const directoryB = join(fixture.root, "project-b");
		const slugB = await addProject(fixture, directoryB);
		const b = await fixture.connect(undefined, undefined, slugB);
		await b.createSession("Idle B", "opencode", "opencode");
		const pids = readFileSync(
			join(fixture.configDir, "fake-opencode-pids.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.flatMap((line) => {
				const { pid, childPid, groupPid } = JSON.parse(line) as {
					pid: number;
					childPid: number;
					groupPid: number;
				};
				return [pid, childPid, groupPid];
			});
		const livePids = () =>
			pids.filter((pid) => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			});
		// Each demand kind alone retains the process through two grace periods.
		const after = Date.now() + 2 * graceMs;
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeRequests()
						.some(
							({ method, url, at }) =>
								method === "GET" && url === "/global/health" && at >= after,
						),
				).toBe(true),
			{ timeout: 2 * graceMs + 5000, interval: 20 },
		);
		evidence["beforeRemoval"] = { kind, pids: livePids() };
		expect(livePids()).toHaveLength(3);
		expect((await b.instanceStatus("opencode")).instance?.status).toBe(
			"healthy",
		);
		await a.close();
		await removeProject(fixture, "process-test");
		const cursor = fixture.opencodeRequests().length;
		evidence["removedAt"] = Date.now();
		await vi.waitFor(
			async () => {
				expect(livePids()).toEqual([]);
				expect((await b.instanceStatus("opencode")).instance?.status).toBe(
					"stopped",
				);
			},
			{ timeout: 15_000, interval: 250 },
		);
		const removedDirectoryRequests = fixture
			.opencodeRequests()
			.slice(cursor)
			.filter(
				({ directory }) => directory === realpathSync(fixture.projectDir),
			);
		evidence["afterRemoval"] = {
			pids: livePids(),
			status: (await b.instanceStatus("opencode")).instance?.status,
			removedDirectoryRequests,
		};
		expect(evidence["afterRemoval"]).toEqual({
			pids: [],
			status: "stopped",
			removedDirectoryRequests: [],
		});
		expect(
			fixture
				.opencodeStreamConnections()
				.filter(({ action }) => action === "close"),
		).toHaveLength(1);
	}, 90_000);

	it("keeps the stream through relay removal and reuses it for a new scope", async () => {
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
		// OpenCode is still running and nothing waits on it, so the stream
		// reconnects without warning anyone.
		await vi.waitFor(
			() =>
				expect(
					fixture
						.opencodeStreamConnections()
						.filter(({ action }) => action === "open"),
				).toHaveLength(2),
			{ timeout: 15_000, interval: 250 },
		);
		const warnings = b.frames
			.slice(cursor)
			.map(({ message }) => message)
			.filter(
				(message) =>
					message["_tag"] === "opencodeConnection" &&
					message["status"] !== "connected",
			);
		expect(warnings).toEqual([]);
		await b.close();
		await removeProject(fixture, slugB);
		// Relays never hold the stream: it follows the instance's demand and
		// idle grace, so a new project reuses it.
		const reopenedSlug = await addProject(fixture, directoryB);
		const reopened = await fixture.connect(undefined, undefined, reopenedSlug);
		await reopened.createSession("Reopened", "opencode", "opencode");
		const connections = fixture.opencodeStreamConnections();
		// The only close is the forced one; it reconnected once.
		expect(connections.filter(({ action }) => action === "open")).toHaveLength(
			2,
		);
		expect(connections.filter(({ action }) => action === "close")).toHaveLength(
			1,
		);
		evidence["connectionStates"] = b.frames
			.map(({ message }) => message)
			.filter((message) => message["_tag"] === "opencodeConnection");
	}, 90_000);
});
