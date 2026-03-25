// ─── Split Scene ─────────────────────────────────────────────────────────────
// Generates GENERATE-SPLIT.gif — Side-by-side Conduit + dummy site showing
// a user prompt, streamed response, and live site update.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { WebSocketRoute } from "@playwright/test";
import { splitInit, splitResponse } from "../fixtures/media-state.js";
import type { SceneDefinition } from "../scene-runner.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");

export const splitScene: SceneDefinition = {
	config: {
		name: "split",
		outputFile: "GENERATE-SPLIT.gif",
		viewport: { width: 1400, height: 800 },
		animated: true,
		deviceScaleFactor: 1,
	},

	async run({ page, context, previewUrl, phase, assert, hold }) {
		// ── Phase 1: Read fixtures and set up route interceptors ─────────
		let compositionHtml: string;
		let dummySiteV1: string;
		let dummySiteV2: string;

		await phase("read-fixtures", async () => {
			compositionHtml = readFileSync(
				path.join(FIXTURES_DIR, "composition.html"),
				"utf-8",
			);
			dummySiteV1 = readFileSync(
				path.join(FIXTURES_DIR, "dummy-site-v1.html"),
				"utf-8",
			);
			dummySiteV2 = readFileSync(
				path.join(FIXTURES_DIR, "dummy-site-v2.html"),
				"utf-8",
			);

			await page.route("**/composition.html", (route) =>
				route.fulfill({
					status: 200,
					contentType: "text/html",
					body: compositionHtml,
				}),
			);
			await page.route("**/dummy-site-v1.html", (route) =>
				route.fulfill({
					status: 200,
					contentType: "text/html",
					body: dummySiteV1,
				}),
			);
			await page.route("**/dummy-site-v2.html", (route) =>
				route.fulfill({
					status: 200,
					contentType: "text/html",
					body: dummySiteV2,
				}),
			);
		});

		// ── Phase 2: Set up WS mock on context (not page!) ──────────────
		await phase("setup-ws-mock", async () => {
			await context.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
				// Send all init messages on connect
				for (const msg of splitInit) {
					ws.send(JSON.stringify(msg));
				}

				ws.onMessage((data) => {
					try {
						const parsed = typeof data === "string" ? JSON.parse(data) : null;
						if (!parsed) return;

						// Stream the response on user message
						if (parsed.type === "message" && typeof parsed.text === "string") {
							void (async () => {
								for (const msg of splitResponse) {
									ws.send(JSON.stringify(msg));
									await new Promise((r) => setTimeout(r, 150));
								}
							})();
							return;
						}

						// Auto-respond to common requests
						if (parsed.type === "get_models") {
							const modelList = splitInit.find((m) => m.type === "model_list");
							if (modelList) ws.send(JSON.stringify(modelList));
							return;
						}

						if (parsed.type === "get_agents") {
							const agentList = splitInit.find((m) => m.type === "agent_list");
							if (agentList) ws.send(JSON.stringify(agentList));
							return;
						}

						if (parsed.type === "load_more_history") {
							ws.send(
								JSON.stringify({
									type: "history_page",
									sessionId: parsed.sessionId ?? "",
									messages: [],
									hasMore: false,
								}),
							);
							return;
						}

						if (parsed.type === "list_sessions") {
							const sessionList = splitInit.find(
								(m) => m.type === "session_list",
							);
							if (sessionList) ws.send(JSON.stringify(sessionList));
							return;
						}

						// Silently ignore everything else
					} catch {
						// Ignore parse errors
					}
				});
			});
		});

		// ── Phase 3: Navigate to composition page ───────────────────────
		await phase("navigate-composition", async () => {
			await page.goto(`${previewUrl}/composition.html`, {
				waitUntil: "domcontentloaded",
			});
		});

		// ── Phase 4: Load iframes ───────────────────────────────────────
		await phase("load-iframes", async () => {
			await page.evaluate(
				([conduitUrl, siteUrl]) => {
					const conduitFrame = document.getElementById(
						"conduit-frame",
					) as HTMLIFrameElement;
					const siteFrame = document.getElementById(
						"site-frame",
					) as HTMLIFrameElement;
					conduitFrame.src = conduitUrl;
					siteFrame.src = siteUrl;
				},
				[`${previewUrl}/p/saas-landing/`, `${previewUrl}/dummy-site-v1.html`],
			);
		});

		// ── Assert: Iframes loaded ──────────────────────────────────────
		await assert("iframes-loaded", async () => {
			await page
				.frameLocator("#conduit-frame")
				.locator("textarea")
				.waitFor({ state: "visible", timeout: 10000 });
			await page
				.frameLocator("#site-frame")
				.getByText("Acme")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		// ── Hold: Show initial state ────────────────────────────────────
		await hold(2000, "initial-state");

		// ── Phase 7: Type message ───────────────────────────────────────
		await phase("type-message", async () => {
			const textarea = page.frameLocator("#conduit-frame").locator("textarea");
			await textarea.click();
			await textarea.pressSequentially(
				"Add a gradient hero section with a CTA button",
				{ delay: 30 },
			);
		});

		// ── Hold: Before send ───────────────────────────────────────────
		await hold(500, "before-send");

		// ── Phase 9: Send message ───────────────────────────────────────
		await phase("send-message", async () => {
			const textarea = page.frameLocator("#conduit-frame").locator("textarea");
			await textarea.press("Enter");
		});

		// ── Hold: Response streaming ────────────────────────────────────
		await hold(3000, "response-streaming");

		// ── Phase 11: Swap to v2 ────────────────────────────────────────
		await phase("swap-to-v2", async () => {
			await page.evaluate((url) => {
				const siteFrame = document.getElementById(
					"site-frame",
				) as HTMLIFrameElement;
				siteFrame.src = url;
			}, `${previewUrl}/dummy-site-v2.html`);
		});

		// ── Assert: Hero section visible ────────────────────────────────
		await assert("hero-section-visible", async () => {
			await page
				.frameLocator("#site-frame")
				.getByText("Ship")
				.first()
				.waitFor({ state: "visible", timeout: 5000 });
		});

		// ── Hold: Final result ──────────────────────────────────────────
		await hold(3000, "final-result");
	},
};
