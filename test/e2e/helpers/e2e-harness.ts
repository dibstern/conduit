// ─── E2E Harness ─────────────────────────────────────────────────────────────
// Two harness modes:
//
// 1. createE2EHarness()    — real relay + real OpenCode (live E2E tests)
// 2. createReplayHarness() — real relay + MockOpenCodeServer (replay tests)
//
// Both serve the built frontend from dist/frontend/ via the relay's static
// file server, so Playwright can navigate directly to the relay URL.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	createRelayStack,
	type RelayStack,
} from "../../../src/lib/relay/relay-stack.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import {
	isOpenCodeRunning,
	switchModelViaWs,
} from "../../helpers/opencode-utils.js";
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

	const stack = await createRelayStack({
		port: 0,
		host: "127.0.0.1",
		opencodeUrl,
		projectDir: process.cwd(),
		slug: "e2e-test",
		sessionTitle: "E2E Test Session",
		staticDir,
		log: createSilentLogger(),
	});

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;

	const createdSessionIds: string[] = [];
	const initialSessionId = await stack.sessionMgr.getDefaultSessionId();
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
	/** Project URL path for Playwright navigation (e.g. "/p/e2e-replay/") */
	projectUrl: string;
	stop(): Promise<void>;
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
): Promise<ReplayHarness> {
	const recording = loadOpenCodeRecording(recordingName);
	const mock = new MockOpenCodeServer(recording);
	await mock.start();

	const staticDir = path.resolve(import.meta.dirname, "../../../dist/frontend");

	// Use an isolated temp dir for config/cache to avoid stale JSONL files
	// from previous runs polluting the MessageCache.
	const configDir = mkdtempSync(path.join(tmpdir(), "e2e-relay-"));

	const stack = await createRelayStack({
		port: 0,
		host: "127.0.0.1",
		opencodeUrl: mock.url,
		projectDir: process.cwd(),
		slug: "e2e-replay",
		sessionTitle: "E2E Replay Session",
		staticDir,
		configDir,
		log: createSilentLogger(),
	});

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;

	return {
		stack,
		mock,
		relayPort,
		relayBaseUrl,
		projectUrl: "/p/e2e-replay/",
		async stop(): Promise<void> {
			await stack.stop();
			await mock.stop();
		},
	};
}
