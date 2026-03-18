// ─── Relay Harness ───────────────────────────────────────────────────────────
// Starts the relay stack pointed at a MockOpenCodeServer backed by recordings.
// Integration tests use this to exercise the exact same wiring as production,
// without requiring a live OpenCode instance.

import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	createRelayStack,
	type RelayStack,
} from "../../../src/lib/relay/relay-stack.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import { TestWsClient } from "./test-ws-client.js";

export interface RelayHarness {
	stack: RelayStack;
	mock: MockOpenCodeServer;
	relayPort: number;
	relayBaseUrl: string;

	/** Connect a test WebSocket client to the relay */
	connectWsClient(): Promise<TestWsClient>;

	/** Stop the relay and clean up */
	stop(): Promise<void>;
}

/**
 * Create a relay harness backed by a recorded OpenCode interaction.
 * Uses port 0 (OS-assigned) to avoid conflicts.
 */
export async function createRelayHarness(
	recordingName = "chat-simple",
): Promise<RelayHarness> {
	const recording = loadOpenCodeRecording(recordingName);
	const mock = new MockOpenCodeServer(recording);
	await mock.start();

	const stack = await createRelayStack({
		port: 0,
		host: "127.0.0.1",
		opencodeUrl: mock.url,
		projectDir: process.cwd(),
		slug: "integration-test",
		sessionTitle: "Integration Test Session",
		log: createSilentLogger(),
	});

	const relayPort = stack.getPort();
	const relayBaseUrl = `http://127.0.0.1:${relayPort}`;
	const clients: TestWsClient[] = [];

	return {
		stack,
		mock,
		relayPort,
		relayBaseUrl,

		async connectWsClient(): Promise<TestWsClient> {
			const client = new TestWsClient(`ws://127.0.0.1:${relayPort}/ws`);
			clients.push(client);
			await client.waitForOpen();
			return client;
		},

		async stop(): Promise<void> {
			for (const c of clients) {
				await c.close().catch(() => {});
			}
			await stack.stop();
			await mock.stop();
		},
	};
}
