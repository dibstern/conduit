// ─── Shared OpenCode Test Utilities ──────────────────────────────────────────
// Helper functions shared between integration and E2E test harnesses.

import WebSocket from "ws";

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
	return new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws`);
		const timer = setTimeout(() => {
			ws.close();
			reject(new Error("Timeout switching model"));
		}, 5000);
		ws.on("open", () => {
			ws.send(JSON.stringify({ type: "switch_model", modelId, providerId }));
			setTimeout(() => {
				clearTimeout(timer);
				ws.close();
				resolve();
			}, 300);
		});
		ws.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
