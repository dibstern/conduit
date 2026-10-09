// Helper functions shared between integration and E2E test harnesses.

import { TestWsClient } from "../integration/helpers/test-ws-client.js";

const OPENCODE_URL = process.env["OPENCODE_URL"] ?? "http://localhost:4096";

export async function isOpenCodeRunning(url?: string): Promise<boolean> {
	try {
		const res = await fetch(`${url ?? OPENCODE_URL}/path`, {
			signal: AbortSignal.timeout(3000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export async function switchModelViaWs(
	relayPort: number,
	modelId: string,
	providerId: string,
): Promise<void> {
	const client = new TestWsClient(`ws://127.0.0.1:${relayPort}/rpc?p=e2e`);
	try {
		await client.waitForOpen();
		await client.waitForInitialState();
		await client.switchModel(modelId, providerId);
	} finally {
		await client.close();
	}
}
