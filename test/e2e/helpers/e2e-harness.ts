// Two harness modes, both an in-process daemon serving the built frontend
// from dist/frontend/, so Playwright navigates straight to the daemon URL:
//
// 1. createE2EHarness()    — real OpenCode (live E2E tests)
// 2. createReplayHarness() — MockOpenCodeServer replaying a recording

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
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
	loadRelaySettings,
	saveRelaySettings,
} from "../../../src/lib/daemon/relay-settings.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../../src/lib/instance/sdk-factory.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { stopPtyHost } from "../../../src/lib/terminal/pty-host-client.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";
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
const staticDir = path.resolve(import.meta.dirname, "../../../dist/frontend");

export interface E2EHarness {
	project: DaemonProject;
	/** OpenCode client for the harness project's folder. */
	client: OpenCodeAPI;
	opencodeUrl: string;
	relayPort: number;
	relayBaseUrl: string;
	model: string;
	provider: string;
	stop(): Promise<void>;
	/** Register a session created during the test run so it gets cleaned up on stop(). */
	trackSession(id: string): void;
}

/** Create a daemon project pointed at real OpenCode, serving the built frontend */
export async function createE2EHarness(opts?: {
	opencodeUrl?: string;
	projectDir?: string;
}): Promise<E2EHarness> {
	const opencodeUrl = opts?.opencodeUrl ?? OPENCODE_URL;
	const projectDir = opts?.projectDir ?? process.cwd();
	const configDir = mkdtempSync(path.join(tmpdir(), "e2e-live-relay-"));
	await saveDaemonConfig(
		{
			...defaultDaemonConfig(),
			avatar: { kind: "initial" },
		},
		configDir,
	);
	const project = await createDaemonProject("chat-simple", {
		configDir,
		opencodeUrl,
		projectDir,
		slug: "e2e-test",
		staticDir,
		// OpenCode's own default model, as a live instance configures it.
		defaultModel: null,
	});
	if (E2E_MODEL && E2E_PROVIDER)
		await switchModelViaWs(project.port, E2E_MODEL, E2E_PROVIDER);

	const { client: sdk, authHeaders } = createSdkClient({
		baseUrl: opencodeUrl,
		directory: projectDir,
	});
	const client = new OpenCodeAPI({ sdk, baseUrl: opencodeUrl, authHeaders });
	const createdSessionIds: string[] = [];

	return {
		project,
		client,
		opencodeUrl,
		relayPort: project.port,
		relayBaseUrl: project.baseUrl,
		model: E2E_MODEL,
		provider: E2E_PROVIDER,
		async stop(): Promise<void> {
			for (const id of createdSessionIds) {
				try {
					await client.session.delete(id);
				} catch {
					// Best-effort cleanup
				}
			}
			try {
				await project.stop();
			} finally {
				await stopPtyHost({ configDir, force: true });
			}
			rmSync(configDir, { recursive: true, force: true });
		},
		trackSession(id: string): void {
			createdSessionIds.push(id);
		},
	};
}

export interface ReplayHarness {
	/** The daemon project; a restart replaces it. */
	readonly project: DaemonProject;
	mock: MockOpenCodeServer;
	relayPort: number;
	relayBaseUrl: string;
	/** The replay session's route (e.g. "/s/ses_abc"); `/` opens no session.
	 *  With a Claude replay plan, the route of a fresh Claude session instead. */
	projectUrl: string;
	/** Present when the harness was created with a Claude replay plan. */
	claudeReplayer?: ClaudeTraceReplayer;
	/** The fresh per-run SQLite event store. */
	eventsDbPath: string;
	/** Stop the daemon and start a fresh one on the same port, config dir and
	 *  event store, as a daemon restart would. Open pages reconnect on their own.
	 *  `whileStopped` runs between the two, e.g. to rewrite the event store. */
	restart(whileStopped?: () => void): Promise<void>;
	stop(): Promise<void>;
}

// The model the committed traces were captured with (their system/init
// `model`), so the runtime sees no model drift during replay.
const CLAUDE_TRACE_MODEL = "claude-fable-5";

/** Create a replay session over the typed WS RPC. */
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
 * Create an in-process daemon whose OpenCode is a MockOpenCodeServer replaying
 * a recording. The daemon serves the built frontend from dist/frontend/, so
 * Playwright navigates directly to the daemon URL — no separate vite preview.
 *
 * Each call creates an isolated mock + daemon pair on random ports.
 * Call stop() to clean up both.
 */
export async function createReplayHarness(
	recordingName: string,
	options: {
		projectDir?: string;
		/** Claude lane: open a Claude session whose SDK turns replay these
		 *  committed traces. No live model call is possible. */
		claudeReplay?: ClaudeReplayPlan;
	} = {},
): Promise<ReplayHarness> {
	const mock = new MockOpenCodeServer(loadOpenCodeRecording(recordingName));
	await mock.start();

	// An isolated config dir and event store per harness.
	const configDir = mkdtempSync(path.join(tmpdir(), "e2e-relay-"));
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

	// Each start reads settings.jsonc as it stands, so a restart keeps what
	// the run (or `whileStopped`) saved there.
	const start = (port: number) =>
		createDaemonProject(recordingName, {
			mock,
			configDir,
			port,
			staticDir,
			slug: "e2e-replay",
			...(options.projectDir && { projectDir: options.projectDir }),
			defaultModel: null,
			settings: { ...loadRelaySettings(configDir) },
			...(claudeReplayer && { claudeSdk: claudeReplayer.sdk }),
		});
	let project = await start(0);
	let stoppedProject: DaemonProject | undefined;
	let mockStopped = false;

	const relayPort = project.port;
	// Daemon startup makes no OpenCode requests, so create the replay session
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
		get project() {
			return project;
		},
		mock,
		relayPort,
		relayBaseUrl: project.baseUrl,
		projectUrl: `/s/${encodeURIComponent(sessionId)}`,
		...(claudeReplayer ? { claudeReplayer } : {}),
		eventsDbPath,
		async restart(whileStopped?: () => void): Promise<void> {
			await project.stop();
			whileStopped?.();
			project = await start(relayPort);
		},
		async stop(): Promise<void> {
			try {
				// A later cleanup failure must not stop the same daemon twice.
				if (stoppedProject !== project) {
					await project.stop();
					stoppedProject = project;
				}
				if (!mockStopped) {
					await mock.stop();
					mockStopped = true;
				}
			} finally {
				__setProbeOverrideForTesting(undefined);
				await stopPtyHost({ configDir, force: true });
			}
			rmSync(configDir, { recursive: true, force: true });
		},
	};
}
