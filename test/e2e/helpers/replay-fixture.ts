// Extends Playwright's base test with a `replay` fixture that starts a real
// relay backed by MockOpenCodeServer for each test.
//
// Usage in specs:
//   import { test } from "../helpers/replay-fixture.js";
//
//   test.describe("My Tests", () => {
//     test.use({ recording: "chat-simple" });
//
//     test("does something", async ({ page, relayUrl }) => {
//       await page.goto(relayUrl);
//       // ...
//     });
//   });
//
// Each test gets a fresh MockOpenCodeServer + RelayStack. The relay serves the
// built frontend from dist/frontend/, so no separate vite preview is needed.

import { mkdirSync } from "node:fs";
import { test as base, type Page, type WebSocketRoute } from "@playwright/test";
import { Effect } from "effect";
import type { OpenCodeInstance } from "../../../src/lib/contracts/ws-rpc.js";
import { AccountDirectory } from "../../../src/lib/domain/daemon/Services/account-directory.js";
import type { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";
import type { ClaudeReplayPlan } from "./claude-trace-replayer.js";
import { createReplayHarness, type ReplayHarness } from "./e2e-harness.js";

/** Options that tests can set via test.use() */
interface ReplayOptions {
	/** Name of the .opencode.json.gz recording to use (default: "chat-simple") */
	recording: string;
	/** Claude lane: open a Claude session replaying these SDK traces, one per
	 *  sent turn. The test fails unless exactly the planned turns are sent. */
	claudeReplay: ClaudeReplayPlan | undefined;
	/** Optional isolated project, prepared before the harness creates a session. */
	projectDir: string | undefined;
	daemonSessionQueries: boolean;
}

/** Fixtures provided to tests */
interface ReplayFixtures {
	/** The full URL to navigate to (relay base URL + project path) */
	relayUrl: string;
	/** The mock OpenCode server (for assertions or mid-test inspection) */
	mockServer: MockOpenCodeServer;
	/** The full replay harness (for advanced use) */
	harness: ReplayHarness;
	/** The relay's accounts as the daemon would publish them. */
	relayInstances: readonly OpenCodeInstance[];
}

export const test = base.extend<ReplayFixtures & ReplayOptions>({
	// Default recording — override per-describe with test.use({ recording: "..." })
	recording: ["chat-simple", { option: true }],
	claudeReplay: [undefined, { option: true }],
	projectDir: [undefined, { option: true }],
	daemonSessionQueries: [false, { option: true }],

	// Per-test harness lifecycle
	harness: async (
		{ recording, claudeReplay, projectDir, daemonSessionQueries },
		use,
		testInfo,
	) => {
		const previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
		const replayPlan = claudeReplay
			? {
					...claudeReplay,
					transcriptConfigDir: testInfo.outputPath("claude-config"),
				}
			: undefined;
		if (replayPlan) {
			mkdirSync(replayPlan.transcriptConfigDir, { recursive: true });
			process.env["CLAUDE_CONFIG_DIR"] = replayPlan.transcriptConfigDir;
		}
		try {
			const harness = await createReplayHarness(recording, {
				...(replayPlan ? { claudeReplay: replayPlan } : {}),
				...(projectDir ? { projectDir } : {}),
				daemonSessionQueries,
			});
			try {
				await use(harness);
				harness.claudeReplayer?.assertComplete();
			} finally {
				await harness.stop();
			}
		} finally {
			if (replayPlan) {
				if (previousConfigDir === undefined)
					delete process.env["CLAUDE_CONFIG_DIR"];
				else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
			}
		}
	},

	relayUrl: async ({ harness }, use) => {
		await use(harness.relayBaseUrl + harness.projectUrl);
	},

	mockServer: async ({ harness }, use) => {
		await use(harness.mock);
	},

	relayInstances: async ({ harness }, use) => {
		const accounts = await harness.stack.effectRuntime.runtime.runPromise(
			Effect.flatMap(AccountDirectory, (directory) => directory.list),
		);
		await use(
			accounts.map(
				(account): OpenCodeInstance => ({
					id: account.id,
					name: account.name,
					driver: account.driver,
					port: 0,
					managed: account.driver === "opencode" && account.managed === true,
					isDefault: account.isDefault,
					status: "healthy",
					restartCount: 0,
					createdAt: 0,
				}),
			),
		);
	},

	// Page-level RPC routes take precedence over this one, so a page route that
	// forwards to the relay should answer through answerSubscribeInstances too.
	context: async ({ context, relayInstances }, use) => {
		await context.routeWebSocket(/\/rpc/, (ws) => {
			const server = ws.connectToServer();
			const answer = answerSubscribeInstances(ws, relayInstances);
			ws.onMessage((data) => {
				if (!answer(data)) server.send(data);
			});
			server.onMessage((data) => ws.send(data));
		});
		await use(context);
	},

	// Override Playwright's baseURL to point at the relay
	baseURL: async ({ harness }, use) => {
		await use(harness.relayBaseUrl);
	},
});

export { expect } from "@playwright/test";

/**
 * A standalone relay has no daemon to publish accounts, so without this the
 * composer never holds a default pick and cannot send. Answers the browser's
 * SubscribeInstances with the relay's own accounts, as the daemon would, and
 * returns whether it consumed the frame (the request or a follow-up for it).
 */
export function answerSubscribeInstances(
	ws: WebSocketRoute,
	instances: readonly OpenCodeInstance[],
): (data: string | Buffer) => boolean {
	const answered = new Set<string>();
	return (data) => {
		const frame: {
			_tag?: unknown;
			tag?: unknown;
			id?: unknown;
			requestId?: unknown;
		} = typeof data === "string" ? JSON.parse(data) : {};
		if (frame._tag === "Request" && frame.tag === "SubscribeInstances") {
			const requestId = String(frame.id);
			answered.add(requestId);
			ws.send(
				JSON.stringify({
					_tag: "Chunk",
					requestId: frame.id,
					values: [{ instances }],
				}),
			);
			return true;
		}
		return answered.has(String(frame.requestId));
	};
}

/**
 * Navigate to the relay project URL and wait for the WebSocket to connect.
 * Convenience wrapper matching the old `app.goto(PROJECT_URL)` pattern.
 */
export async function gotoRelay(page: Page, relayUrl: string): Promise<void> {
	await page.goto(relayUrl);
	// Wait for Svelte SPA to mount — layout appears on initial render.
	// Without this, the overlay waitFor({ state: 'hidden' }) can pass
	// immediately because Playwright treats "not attached" as "hidden",
	// and #connect-overlay doesn't exist until Svelte renders.
	// Use the full test timeout (30s) — under resource pressure during
	// pnpm test:all, the SPA bundle + Svelte mount can take >15s.
	await page.locator("#layout").waitFor({ state: "attached", timeout: 30_000 });
	// Wait for WebSocket to connect — overlay should disappear
	await page.locator("#connect-overlay").waitFor({
		state: "hidden",
		timeout: 30_000,
	});
}
