// ─── E2E Harness ─────────────────────────────────────────────────────────────
// Two harness modes:
//
// 1. createE2EHarness()    — real relay + real OpenCode (live E2E tests)
// 2. createReplayHarness() — real relay + MockOpenCodeServer (replay tests)
//
// Both serve the built frontend from dist/frontend/ via the relay's static
// file server, so Playwright can navigate directly to the relay URL.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	createRelayStack,
	type RelayStack,
} from "../../../src/lib/relay/relay-stack.js";
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

// ─── Live Harness ────────────────────────────────────────────────────────────

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
}): Promise<E2EHarness> {
	const opencodeUrl = opts?.opencodeUrl ?? OPENCODE_URL;

	const staticDir = path.resolve(import.meta.dirname, "../../../dist/frontend");
	const dbDir = mkdtempSync(path.join(tmpdir(), "e2e-live-relay-"));

	const startStack = (port: number) =>
		createRelayStack({
			port,
			host: "127.0.0.1",
			opencodeUrl,
			projectDir: process.cwd(),
			slug: "e2e-test",
			sessionTitle: "E2E Test Session",
			staticDir,
			persistenceDbPath: path.join(dbDir, "events.db"),
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
			await stack.stop();
			rmSync(dbDir, { recursive: true, force: true });
		},
		trackSession(id: string): void {
			createdSessionIds.push(id);
		},
	};
}

// ─── Replay Harness ──────────────────────────────────────────────────────────

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

/** Create a relay-owned Claude session over the typed WS RPC. */
async function createClaudeSession(relayPort: number): Promise<string> {
	const { sessionId } = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcClient.make(WsRpcGroup);
				return yield* client.CreateSession({
					projectSlug: "e2e-replay",
					originId: "e2e-claude-replay",
					providerId: "claude",
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
	if (claudeReplayer) {
		// Capability discovery would otherwise spawn the real Claude CLI.
		__setProbeOverrideForTesting(async () => ({
			models: [
				{
					id: CLAUDE_TRACE_MODEL,
					name: "Claude Fable 5",
					providerId: "claude",
				},
			],
			commands: [],
			agents: [],
		}));
	}

	const startStack = (port: number) =>
		createRelayStack({
			port,
			host: "127.0.0.1",
			opencodeUrl: mock.url,
			projectDir: process.cwd(),
			slug: "e2e-replay",
			sessionTitle: "E2E Replay Session",
			staticDir,
			configDir,
			persistenceDbPath: eventsDbPath,
			...(claudeReplayer ? { claudeSdk: claudeReplayer.sdk } : {}),
			log: createSilentLogger(),
		});
	let stack = await startStack(0);

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;
	const sessionId = claudeReplayer
		? await createClaudeSession(relayPort)
		: stack.initialSessionId;

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
			await stack.stop();
			await mock.stop();
			if (claudeReplayer) __setProbeOverrideForTesting(undefined);
			rmSync(configDir, { recursive: true, force: true });
		},
	};
}
