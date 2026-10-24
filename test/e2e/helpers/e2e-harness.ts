import { createTestRelayStack as createRelayStack } from "../../helpers/project-relay.js";
// Two harness modes:
//
// 1. createE2EHarness()    — real relay + real OpenCode (live E2E tests)
// 2. createReplayHarness() — real relay + MockOpenCodeServer (replay tests)
//
// Both serve the built frontend from dist/frontend/ via the relay's static
// file server, so Playwright can navigate directly to the relay URL.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import {
	AccountIdSchema,
	MANAGED_OPENCODE_ACCOUNT_ID,
} from "../../../src/lib/contracts/provider-instance.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	defaultDaemonConfig,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	listArchivedSessions,
	listDaemonSessions,
} from "../../../src/lib/domain/daemon/Services/daemon-session-reader.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import {
	DaemonSessionQueryServiceError,
	DaemonSessionQueryServiceTag,
} from "../../../src/lib/domain/relay/Services/daemon-session-query-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	makePersistenceStoreLayer,
	PersistenceStore,
	type PersistenceStoreContext,
} from "../../../src/lib/persistence/effect/live.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import type { RelayStack } from "../../../src/lib/relay/relay-stack.js";
import { stopPtyHost } from "../../../src/lib/terminal/pty-host-client.js";
import { claudeSdk as fakeClaudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import {
	isOpenCodeRunning,
	switchModelViaWs,
} from "../../helpers/opencode-utils.js";
import {
	type ClaudeReplayPlan,
	type ClaudeTraceReplayer,
	createClaudeTraceReplayer,
} from "./claude-trace-replayer.js";
import { loadOpenCodeRecording } from "./recorded-loader.js";

export { isOpenCodeRunning };

const OPENCODE_URL = process.env["OPENCODE_URL"] ?? "http://localhost:4096";
// Only switch model if BOTH env vars are explicitly set — otherwise use OpenCode's default
const E2E_MODEL = process.env["E2E_MODEL"] ?? "";
const E2E_PROVIDER = process.env["E2E_PROVIDER"] ?? "";

export interface E2EHarness {
	stack: RelayStack;
	opencodeUrl: string;
	relayPort: number;
	relayBaseUrl: string;
	model: string;
	provider: string;
	stop(): Promise<void>;
	/** Register a session created during the test run so it gets cleaned up on stop(). */
	trackSession(id: string): void;
}

/**
 * Switch to a free-tier model if E2E_MODEL and E2E_PROVIDER env vars are set.
 * Delegates to the shared switchModelViaWs helper.
 */
async function switchToFreeModel(relayPort: number): Promise<void> {
	if (!E2E_MODEL || !E2E_PROVIDER) return;
	await switchModelViaWs(relayPort, E2E_MODEL, E2E_PROVIDER);
}

/** Create a relay pointed at real OpenCode, serving the built frontend */
export async function createE2EHarness(opts?: {
	opencodeUrl?: string;
	projectDir?: string;
}): Promise<E2EHarness> {
	const opencodeUrl = opts?.opencodeUrl ?? OPENCODE_URL;

	const staticDir = path.resolve(import.meta.dirname, "../../../dist/frontend");
	const dbDir = mkdtempSync(path.join(tmpdir(), "e2e-live-relay-"));
	await saveDaemonConfig(
		{
			...defaultDaemonConfig(),
			avatar: { kind: "initial" },
		},
		dbDir,
	);

	const startStack = (port: number) =>
		createRelayStack({
			port,
			host: "127.0.0.1",
			opencodeUrl,
			projectDir: opts?.projectDir ?? process.cwd(),
			slug: "e2e-test",
			sessionTitle: "E2E Test Session",
			staticDir,
			configDir: dbDir,
			persistenceDbPath: path.join(dbDir, "events.db"),
			// Stubbed session titles: no test makes a live title call.
			titleQuery: fakeClaudeSdk.titleQuery,
			log: createSilentLogger(),
		});
	const stack = await startStack(0);

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;

	const createdSessionIds: string[] = [];
	const initialSessionId = stack.initialSessionId;
	if (initialSessionId) createdSessionIds.push(initialSessionId);

	await switchToFreeModel(relayPort);

	return {
		stack,
		opencodeUrl,
		relayPort,
		relayBaseUrl,
		model: E2E_MODEL,
		provider: E2E_PROVIDER,
		async stop(): Promise<void> {
			for (const id of createdSessionIds) {
				try {
					await stack.client.session.delete(id);
				} catch {
					// Best-effort cleanup
				}
			}
			try {
				await stack.stop();
			} finally {
				await stopPtyHost({ configDir: dbDir, force: true });
			}
			rmSync(dbDir, { recursive: true, force: true });
		},
		trackSession(id: string): void {
			createdSessionIds.push(id);
		},
	};
}

export interface ReplayHarness {
	stack: RelayStack;
	mock: MockOpenCodeServer;
	relayPort: number;
	relayBaseUrl: string;
	/** The relay's startup session route (e.g. "/s/ses_abc"); `/` opens no session.
	 *  With a Claude replay plan, the route of a fresh Claude session instead. */
	projectUrl: string;
	/** Present when the harness was created with a Claude replay plan. */
	claudeReplayer?: ClaudeTraceReplayer;
	/** The fresh per-run SQLite event store. */
	eventsDbPath: string;
	/** Stop the relay and start a fresh one on the same port, config dir and
	 *  event store, as a daemon restart would. Open pages reconnect on their own.
	 *  `whileStopped` runs between the two, e.g. to rewrite the event store. */
	restart(whileStopped?: () => void): Promise<void>;
	stop(): Promise<void>;
}

// The model the committed traces were captured with (their system/init
// `model`), so the runtime sees no model drift during replay.
const CLAUDE_TRACE_MODEL = "claude-fable-5";

/** Create a relay-owned replay session over the typed WS RPC. */
export async function createSession(
	relayPort: number,
	providerId: "claude" | "opencode",
	instanceId?: string,
	title?: string,
	projectSlug = "e2e-replay",
): Promise<string> {
	const { sessionId } = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcClient.make(WsRpcGroup);
				const modelCatalog = yield* client.GetModels({
					projectSlug,
					instanceId:
						instanceId === undefined
							? providerId === "opencode"
								? MANAGED_OPENCODE_ACCOUNT_ID
								: AccountIdSchema.make("claude-sdk")
							: AccountIdSchema.make(instanceId),
				});
				if (!modelCatalog.active)
					throw new Error(
						"The replay fixture needs a valid harness model pick",
					);
				return yield* client.CreateSession({
					...(title === undefined ? {} : { title }),
					permissionMode: "ask",
					projectSlug,
					originId: `e2e-${providerId}-replay`,
					providerId,
					model: {
						providerId: modelCatalog.active.provider,
						modelId: modelCatalog.active.model,
						variant: modelCatalog.variant?.variant ?? "",
						contextWindow: modelCatalog.contextWindow?.contextWindow ?? "",
					},
					// Naming the instance routes creation through OpenCode Instances
					// `use`, which opens the event stream replayed turns arrive on.
					...(modelCatalog.instanceId === undefined
						? {}
						: { instanceId: AccountIdSchema.make(modelCatalog.instanceId) }),
				});
			}),
		).pipe(
			Effect.provide(RpcClient.layerProtocolSocket()),
			Effect.provide(Socket.layerWebSocket(`ws://127.0.0.1:${relayPort}/rpc`)),
			Effect.provide(Socket.layerWebSocketConstructorGlobal),
			Effect.provide(RpcSerialization.layerJson),
		),
	);
	return sessionId;
}

/**
 * Create a relay backed by a MockOpenCodeServer replaying a recording.
 * The relay serves the built frontend from dist/frontend/, so Playwright
 * navigates directly to the relay URL — no separate vite preview needed.
 *
 * Each call creates an isolated mock + relay pair on random ports.
 * Call stop() to clean up both.
 */
export async function createReplayHarness(
	recordingName: string,
	options: {
		projectDir?: string;
		/** Exercise the real daemon browse/search reads against this isolated store. */
		daemonSessionQueries?: boolean;
		/** Claude lane: open a Claude session whose SDK turns replay these
		 *  committed traces. No live model call is possible. */
		claudeReplay?: ClaudeReplayPlan;
	} = {},
): Promise<ReplayHarness> {
	const recording = loadOpenCodeRecording(recordingName);
	const mock = new MockOpenCodeServer(recording);
	await mock.start();

	const staticDir = path.resolve(import.meta.dirname, "../../../dist/frontend");

	// Use an isolated temp dir for config/cache to avoid stale JSONL files
	// from previous runs polluting the MessageCache.
	const configDir = mkdtempSync(path.join(tmpdir(), "e2e-relay-"));
	// Without a default model the first session is a local Claude one, and the
	// recording's OpenCode session is never created or viewed.
	writeFileSync(
		path.join(configDir, "settings.jsonc"),
		JSON.stringify({ defaultModel: "anthropic/claude-opus-4-5-20251101" }),
	);

	const claudeReplayer =
		options.claudeReplay && createClaudeTraceReplayer(options.claudeReplay);
	const eventsDbPath = path.join(configDir, "events.db");
	saveRelaySettings(
		{
			defaultModel: claudeReplayer
				? `claude/${CLAUDE_TRACE_MODEL}`
				: "opencode/big-pickle",
		},
		configDir,
	);
	const claudeInstanceId = options.claudeReplay?.instanceId;
	// The user has already answered the avatar question, so the first-run
	// dialog stays shut over the specs that are not about it.
	await saveDaemonConfig(
		{
			...defaultDaemonConfig(),
			avatar: { kind: "initial" },
			...(claudeReplayer && {
				instances: [
					{
						id: claudeInstanceId ?? "claude",
						name: claudeInstanceId ?? "Claude",
						port: 0,
						managed: false,
						driver: "claude",
						configDir:
							options.claudeReplay?.transcriptConfigDir ??
							path.join(configDir, "claude"),
					},
				],
			}),
		},
		configDir,
	);
	// Capability discovery would otherwise spawn the real Claude CLI, even for
	// OpenCode-only replays (GetModels also discovers the default Claude), and
	// that process outlives stop() and writes into configDir.
	__setProbeOverrideForTesting(async () => ({
		models: claudeReplayer
			? (options.claudeReplay?.models ?? [
					{
						id: CLAUDE_TRACE_MODEL,
						name: "Claude Fable 5",
						providerId: "claude",
						// The real catalog advertises effort levels for Fable.
						variants: { low: {}, medium: {}, high: {} },
					},
				])
			: [],
		commands: [],
		agents: [],
	}));

	const daemonReads = options.daemonSessionQueries
		? ManagedRuntime.make(
				Layer.mergeAll(
					makeProjectRegistryLive([
						{
							folders: [options.projectDir ?? process.cwd()],
							slug: "e2e-replay",
							title: "E2E Replay",
						},
					]),
					Layer.effect(
						PersistenceStore,
						Effect.context<PersistenceStoreContext>(),
					).pipe(Layer.provideMerge(makePersistenceStoreLayer(eventsDbPath))),
				),
			)
		: undefined;
	const daemonReadContext = daemonReads
		? await daemonReads.context()
		: undefined;
	const startStack = (port: number): Promise<RelayStack> =>
		createRelayStack({
			port,
			host: "127.0.0.1",
			opencodeUrl: mock.url,
			projectDir: options.projectDir ?? process.cwd(),
			slug: "e2e-replay",
			sessionTitle: "E2E Replay Session",
			staticDir,
			configDir,
			persistenceDbPath: eventsDbPath,
			...(daemonReadContext
				? {
						daemonConfigContext: Context.add(
							daemonReadContext,
							DaemonSessionQueryServiceTag,
							{
								listArchived: (query) =>
									Effect.tryPromise({
										try: () =>
											stack.effectRuntime.runtime.runPromise(
												listArchivedSessions(query).pipe(
													Effect.provide(daemonReadContext),
												),
											),
										catch: (cause) =>
											new DaemonSessionQueryServiceError({ cause }),
									}),
								list: (query) =>
									Effect.tryPromise({
										try: () =>
											stack.effectRuntime.runtime.runPromise(
												listDaemonSessions(query).pipe(
													Effect.provide(daemonReadContext),
												),
											),
										catch: (cause) =>
											new DaemonSessionQueryServiceError({ cause }),
									}),
							},
						),
					}
				: {}),
			...(claudeReplayer
				? { claudeSdk: claudeReplayer.sdk }
				: { titleQuery: fakeClaudeSdk.titleQuery }),
			log: createSilentLogger(),
		});
	let stack: RelayStack = await startStack(0);

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;
	// Relay startup makes no OpenCode requests, so create the replay session
	// explicitly. For OpenCode this replays the recording's POST /session.
	const sessionId = await createSession(
		relayPort,
		claudeReplayer ? "claude" : "opencode",
		claudeInstanceId,
	);
	if (!claudeReplayer) {
		const connectedBy = Date.now() + 5_000;
		while (!mock.diagnostics.some((entry) => entry.event === "sse_connect")) {
			if (Date.now() >= connectedBy)
				throw new Error("Replay provider SSE did not connect");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	return {
		get stack() {
			return stack;
		},
		mock,
		relayPort,
		relayBaseUrl,
		projectUrl: `/s/${encodeURIComponent(sessionId)}`,
		...(claudeReplayer ? { claudeReplayer } : {}),
		eventsDbPath,
		async restart(whileStopped?: () => void): Promise<void> {
			await stack.stop();
			whileStopped?.();
			stack = await startStack(relayPort);
		},
		async stop(): Promise<void> {
			try {
				await stack.stop();
				await mock.stop();
			} finally {
				await daemonReads?.dispose();
				__setProbeOverrideForTesting(undefined);
				await stopPtyHost({ configDir, force: true });
			}
			rmSync(configDir, { recursive: true, force: true });
		},
	};
}
