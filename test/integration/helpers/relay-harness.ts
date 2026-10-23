import { createTestRelayStack as createRelayStack } from "../../helpers/project-relay.js";
// Starts the relay stack pointed at a MockOpenCodeServer backed by recordings.
// Integration tests use this to exercise the exact same wiring as production,
// without requiring a live OpenCode instance.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
	type DrainReport,
	EventRetentionTag,
} from "../../../src/lib/domain/persistence/Services/event-retention.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	type ReplayParityReport,
	verifyReplayParity,
} from "../../../src/lib/persistence/replay-parity.js";
import type { RelayStack } from "../../../src/lib/relay/relay-stack.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import type { OpenCodeRecording } from "../../e2e/fixtures/recorded/types.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { claudeSdk as fakeClaudeSdk } from "../../helpers/fake-claude-process-sdk.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import { TestWsClient } from "./test-ws-client.js";

export interface RelayHarness {
	stack: RelayStack;
	mock: MockOpenCodeServer;
	relayPort: number;
	relayBaseUrl: string;
	eventsDbPath: string;

	/** Connect a typed browser RPC client to the relay */
	connectWsClient(): Promise<TestWsClient>;

	/** Replay the durable event log and compare its live read model. */
	checkReplayParity(): Promise<ReplayParityReport>;

	/** Reclaim deleted sessions through the project's production retention service. */
	drainEventRetention(): Promise<DrainReport>;

	/** Stop the relay and clean up */
	stop(): Promise<void>;
}

/**
 * Create a relay harness backed by a recorded OpenCode interaction.
 * Uses port 0 (OS-assigned) to avoid conflicts.
 */
export async function createRelayHarness(
	recordingName: string | OpenCodeRecording = "chat-simple",
	options: {
		/** Config directory holding daemon.json (named provider instances). */
		readonly configDir?: string;
		readonly daemonConfigContext?: ProjectRelayConfig["daemonConfigContext"];
		/** Relay default model ("provider/model"); null leaves the native default in control. */
		readonly defaultModel?: string | null;
		readonly claudeSdk?: ProjectRelayConfig["claudeSdk"];
		readonly titleQuery?: ProjectRelayConfig["titleQuery"];
		/** A real OpenCode server to use instead of the recording's mock. */
		readonly opencodeUrl?: string;
	} = {},
): Promise<RelayHarness> {
	const recording =
		typeof recordingName === "string"
			? loadOpenCodeRecording(recordingName)
			: recordingName;
	const mock = new MockOpenCodeServer(recording);
	await mock.start();
	const dbDir = mkdtempSync(join(tmpdir(), "conduit-relay-integration-"));
	const eventsDbPath = join(dbDir, "events.db");
	writeFileSync(
		join(dbDir, "settings.jsonc"),
		JSON.stringify(
			options.defaultModel === null
				? {}
				: {
						defaultModel:
							options.defaultModel ?? "anthropic/claude-opus-4-5-20251101",
					},
		),
	);

	const stack = await createRelayStack({
		port: 0,
		host: "127.0.0.1",
		opencodeUrl: options.opencodeUrl ?? mock.url,
		projectDir: process.cwd(),
		slug: "integration-test",
		sessionTitle: "Integration Test Session",
		log: createSilentLogger(),
		persistenceDbPath: eventsDbPath,
		configDir: options.configDir ?? dbDir,
		...(options.daemonConfigContext
			? { daemonConfigContext: options.daemonConfigContext }
			: {}),
		...(options.claudeSdk ? { claudeSdk: options.claudeSdk } : {}),
		// Stubbed session titles: no test makes a live title call.
		titleQuery:
			options.titleQuery ??
			options.claudeSdk?.titleQuery ??
			fakeClaudeSdk.titleQuery,
	});

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;
	const clients: TestWsClient[] = [];

	return {
		stack,
		mock,
		relayPort,
		relayBaseUrl,
		eventsDbPath,

		async connectWsClient(): Promise<TestWsClient> {
			const client = new TestWsClient(
				`ws://127.0.0.1:${relayPort}/rpc?p=integration-test`,
				stack.initialSessionId,
			);
			clients.push(client);
			await client.waitForOpen();
			return client;
		},

		checkReplayParity(): Promise<ReplayParityReport> {
			return Effect.runPromise(
				verifyReplayParity(eventsDbPath, {
					projectId: "integration-test",
					// Provider reconciliation sets completion outside the event log;
					// replay clears it when rebuilding the read model.
					ignoredColumns: [
						"version",
						"session_sidebar.row.version",
						"sessions.history_complete",
						// A child's drained wake event need not survive its ancestor.
						// These read annotations are outside the log (ADR-0013).
						"sessions.woken_at",
						"sessions.woken_reason",
						"session_sidebar.row.snooze.woken_at",
						"session_sidebar.row.snooze.woken_reason",
					],
				}),
			);
		},

		drainEventRetention(): Promise<DrainReport> {
			return stack.effectRuntime.runtime.runPromise(
				Effect.flatMap(EventRetentionTag, (retention) => retention.drain()),
			);
		},

		async stop(): Promise<void> {
			for (const c of clients) {
				await c.close().catch(() => {});
			}
			await stack.stop();
			await mock.stop();
			rmSync(dbDir, { recursive: true, force: true });
		},
	};
}
