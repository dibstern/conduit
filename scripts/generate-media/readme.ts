// README captures use the acceptance harness's live RPC mocks and real controls.
// Run: pnpm generate:media -- readme-{hero,continuity,craft,control}
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import {
	PINNED_CLOCK_MS,
	PlaywrightDriver,
} from "../../acceptance/src/playwrightDriver.js";
import type {
	AcceptanceWorld,
	StepHandler,
} from "../../acceptance/src/runtime.js";
import { composerLiveStatusHandlers } from "../../acceptance/src/steps/composerLiveStatus.js";
import { seedComposerPickerCatalog } from "../../acceptance/src/steps/composerPicker.js";
import { mockAppHandlers } from "../../acceptance/src/steps/mockApp.js";
import { pendingInputTrayHandlers } from "../../acceptance/src/steps/pendingInputTray.js";
import { providerInstancesHandlers } from "../../acceptance/src/steps/providerInstances.js";
import {
	requireRelayControl,
	requireRpcControl,
	setSessionRowStatus,
} from "../../acceptance/src/steps/shared.js";
import { terminalKeysHandlers } from "../../acceptance/src/steps/terminalKeys.js";
import { terminalSettingsHandlers } from "../../acceptance/src/steps/terminalSettings.js";
import { themeMenuHandlers } from "../../acceptance/src/steps/themeMenu.js";
import { usageFooterMeterHandlers } from "../../acceptance/src/steps/usageFooterMeter.js";
import type { HistoryMessage } from "../../src/lib/shared-types.js";
import type { SceneContext, SceneDefinition } from "./scene-runner.js";

const SESSION = "sess-mockup-001";
const TITLE = "Migrate auth sessions";
const DRAFT = "Also cover the logout path, and check the refresh token expiry";
const MIGRATE = "pnpm db:migrate --env staging";
const handlers: StepHandler[] = [
	...mockAppHandlers,
	...themeMenuHandlers,
	...composerLiveStatusHandlers,
	...usageFooterMeterHandlers,
	...pendingInputTrayHandlers,
	...providerInstancesHandlers,
	...terminalSettingsHandlers,
	...terminalKeysHandlers,
];

async function step(page: Page, text: string): Promise<void> {
	const found = handlers
		.map((handler) => ({ handler, match: text.match(handler.match) }))
		.find(({ match }) => match);
	if (!found?.match) throw new Error(`Missing media fixture step: ${text}`);
	const world: AcceptanceWorld = {
		page,
		driver: new PlaywrightDriver(),
		artifacts: [],
	};
	await found.handler.run({ world, text, match: found.match, example: {} });
}

async function verifyComposer(page: Page): Promise<void> {
	const composer = page.getByTestId("composer-layout");
	const model = composer.locator(".model-label");
	await expect(model).toHaveText("Sonnet 5");
	await expect(model).toBeVisible();
	await expect
		.poll(() =>
			model.evaluate((element) => element.scrollWidth <= element.clientWidth),
		)
		.toBe(true);
	await expect(composer.getByTestId("variant-badge")).toBeVisible();
	await expect(composer.getByTestId("effort-meter")).toBeVisible();
	await expect(composer.getByTestId("permission-mode-badge")).toBeVisible();
	await expect(composer).not.toContainText(/(?:200\s*K|1\s*M|context window)/i);
}

async function seed(
	page: Page,
	ctx: SceneContext,
	running = false,
): Promise<void> {
	process.env["CONDUIT_BASE_URL"] = ctx.previewUrl;
	// Pin Date the way the acceptance driver does; Playwright's clock stalls the catalog refetch.
	await page.addInitScript((pinned) => {
		Date.now = () => pinned;
	}, PINNED_CLOCK_MS);
	await page.addInitScript(() => {
		localStorage.setItem(
			"conduit-composer-preferences",
			JSON.stringify({ controls: "icons" }),
		);
		localStorage.setItem("terminal-font-size", "13");
		localStorage.setItem("terminal-panel-height", "220");
	});
	await step(
		page,
		`the theme starts as ${ctx.theme} with the OS in ${ctx.theme} mode`,
	);
	await step(page, "the conduit app is served with the long-transcript mockup");
	await step(page, "the composer checkout is api / auth as branch");
	const rpc = requireRpcControl(page);
	rpc.setShellRows(
		rpc.shellRows?.filter(
			(row) =>
				typeof row === "object" &&
				row !== null &&
				"id" in row &&
				row.id === SESSION,
		) ?? [],
	);
	setSessionRowStatus(page, SESSION, running ? "busy" : "idle", {
		title: TITLE,
		accountId: "claude",
	});
	await seedComposerPickerCatalog(page, "Claude");
	// The existing catalog and SwitchVariant mock retain the effort selection.
	await page.getByTestId("variant-badge").click();
	await page.getByTestId("variant-badge").click();
	await page.getByTestId("variant-badge").click();
	const messages: HistoryMessage[] = [
		{
			id: "auth-user",
			role: "user",
			createdAt: PINNED_CLOCK_MS - 60_000,
			parts: [
				{
					id: "auth-user-text",
					type: "text",
					text: "Move auth onto the new session store.",
				},
			],
		},
		{
			id: "composer-status-turn",
			role: "assistant",
			createdAt: PINNED_CLOCK_MS - 55_000,
			parts: [
				{
					id: "auth-reply",
					type: "text",
					text: "Swapped the in-memory Map for the SQLite store, and the auth tests pass. Staging needs the new table before I deploy.",
				},
			],
		},
	];
	const relay = requireRelayControl(page);
	relay.sendMessage({
		type: "mock_transcript_snapshot",
		id: SESSION,
		history: { messages: running ? [] : messages, hasMore: false },
	});
	if (running) {
		// A turn is live only when its prompt arrives live, as a real send does.
		relay.sendMessage({
			type: "user_message",
			sessionId: SESSION,
			messageId: "auth-user",
			text: "Move auth onto the new session store.",
			createdAt: PINNED_CLOCK_MS - 60_000,
		});
	}
	await expect(page.locator("#messages")).toContainText(
		"Move auth onto the new session store.",
	);
	await step(page, `the app shows the ${ctx.theme} theme`);
	await expect(page.locator("#session-bar")).toContainText(TITLE);
	await verifyComposer(page);
}

async function permission(page: Page): Promise<void> {
	const rpc = requireRpcControl(page);
	await expect.poll(() => rpc.hasStream("SubscribeApprovals")).toBe(true);
	rpc.sendChunk("SubscribeApprovals", [
		{
			_tag: "upsert",
			sequence: 1,
			item: {
				_tag: "permission",
				sessionId: SESSION,
				requestId: "auth-staging-permission",
				toolUseId: "auth-migrate",
				toolName: "Bash",
				toolInput: { command: MIGRATE },
			},
		},
	]);
	setSessionRowStatus(page, SESSION, "busy", {
		attention: "needs-approval",
		pendingPermissionCount: 1,
	});
	await expect(
		page.getByRole("button", { name: "Allow", exact: true }),
	).toBeVisible();
	await expect(page.locator("#messages")).toContainText(MIGRATE);
}

async function terminal(page: Page, phone: boolean): Promise<void> {
	await step(
		page,
		`Terminal settings have their defaults on ${phone ? "iOS" : "macOS"}`,
	);
	await step(page, "I open a new terminal tab");
	const rpc = requireRpcControl(page);
	const prompt = "\x1b[36m~/api\x1b[0m \x1b[35mauth\x1b[0m $ ";
	const output = phone
		? [
				`${prompt}pnpm test auth`,
				"\x1b[32m ✓\x1b[0m auth/store.test.ts (12 tests)",
				"\x1b[32m ✓\x1b[0m auth/login.test.ts (8 tests)",
				"",
				" Test Files  \x1b[32m2 passed\x1b[0m (2)",
				"      Tests  \x1b[32m20 passed\x1b[0m (20)",
				"   Duration  1.84s",
				"",
				`${prompt}git push -u origin auth`,
				"To github.com:you/api.git",
				" * [new branch]   auth -> auth",
				`${prompt}`,
			]
		: [
				`${prompt}git status --short`,
				" M src/auth/store.ts",
				" M src/auth/session.ts",
				"?? migrations/0007_sessions.sql",
				`${prompt}`,
			];
	rpc.sendChunk("SubscribePtys", [
		{
			_tag: "output",
			ptyId: "terminal-1",
			data: output.join("\r\n"),
			replace: true,
		},
	]);
	await expect(page.locator("#terminal-panel .xterm-rows")).toContainText(
		phone ? "auth -> auth" : "0007_sessions.sql",
	);
	// xterm paints its write queue on animation frames, outside Svelte's updates.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
	if (phone) {
		await step(
			page,
			"the terminal key row is paste or copy, esc or tab, ⌃ or ⌘, ⌥ or ⇧, the arrow pad and the keyboard toggle",
		);
		await expect(
			page.getByRole("button", {
				name: "Escape, flick up for Tab",
				exact: true,
			}),
		).toBeVisible();
	} else {
		await expect(
			page.getByRole("button", {
				name: "Escape, flick up for Tab",
				exact: true,
			}),
		).toHaveCount(0);
	}
}

async function capture(
	ctx: SceneContext,
	viewport: { width: number; height: number },
	setup: (page: Page) => Promise<void>,
	selector?: string,
): Promise<string> {
	const phone = viewport.width < 768;
	const context = await ctx.browser.newContext({
		viewport,
		deviceScaleFactor: 2,
		colorScheme: ctx.theme,
		isMobile: phone,
		hasTouch: phone,
		locale: "en-US",
		timezoneId: "UTC",
	});
	const page = await context.newPage();
	try {
		await setup(page);
		await page.evaluate(() => document.fonts.ready);
		const options = {
			type: "png" as const,
			animations: "disabled" as const,
			caret: "hide" as const,
		};
		const buffer = selector
			? await page.locator(selector).screenshot(options)
			: await page.screenshot(options);
		return `data:image/png;base64,${buffer.toString("base64")}`;
	} catch (error) {
		// The runner's own failure shot is of the compositor page, which is blank.
		await page
			.screenshot({
				path: join(ctx.mediaDir, "_debug", `readme-${ctx.theme}-capture.png`),
			})
			.catch(() => {});
		throw error;
	} finally {
		await context.close();
	}
}

async function compose(ctx: SceneContext, content: string): Promise<void> {
	const light = ctx.theme === "light";
	await ctx.page.setContent(`<!doctype html><html><head><style>
		*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
		body{background:${light ? "#edf0f4" : "#141820"};color:${light ? "#252b36" : "#d9e1ed"};font:15px system-ui}
		img{display:block;width:100%;height:auto}figure{margin:0;overflow:hidden;background:${light ? "#fff" : "#1c212b"};border:1px solid ${light ? "#cbd2dd" : "#3b4352"};box-shadow:0 18px 45px #0003}
		.browser{border-radius:12px}.chrome{height:32px;display:flex;align-items:center;gap:7px;padding:0 12px;background:${light ? "#e3e7ed" : "#242b36"}}
		.chrome i{width:8px;height:8px;border-radius:50%;background:#8a94a5}.chrome span{margin:auto;font-size:11px;opacity:.7}
		.phone{border-radius:22px;border-width:5px}.hero-desktop{position:absolute;left:48px;top:48px;width:1282px}.hero-phone{position:absolute;left:1190px;top:304px;width:306px}
		.card-phone{position:absolute;width:400px;left:40px;top:24px}.drafts{box-sizing:border-box;min-height:100vh;padding:38px 24px;display:flex;flex-direction:column;justify-content:center;gap:20px}
		.drafts p{margin:0;font-size:16px;font-weight:550}.drafts figure{border-radius:12px}.drafts .desktop-draft{margin-bottom:30px}.drafts .phone-draft{width:390px;align-self:center}
	</style></head><body>${content}</body></html>`);
	await ctx.page.locator("img").evaluateAll(async (images) => {
		await Promise.all(
			images.map((image) => (image as HTMLImageElement).decode()),
		);
	});
}

export const readmeScenes: SceneDefinition[] = [
	{
		config: {
			name: "readme-hero",
			outputFile: "readme/hero-{theme}.png",
			viewport: { width: 1600, height: 1000 },
			animated: false,
			themes: ["light", "dark"],
		},
		async run(ctx) {
			await ctx.phase("desktop permission, terminal and usage", async () => {
				const desktop = await capture(
					ctx,
					{ width: 1280, height: 800 },
					async (page) => {
						await seed(page, ctx);
						await step(
							page,
							"the usage footer has a Claude account and a hidden Codex account named ChatGPT",
						);
						await step(
							page,
							"the usage footer claude five_hour reading is 41% resetting at none",
						);
						await step(
							page,
							"the usage footer claude seven_day reading is 22% resetting at none",
						);
						await step(
							page,
							"the usage footer hidden five_hour reading is 95% resetting at none",
						);
						await expect(
							page.getByTestId("usage-footer-row-hidden"),
						).toContainText("95%");
						// The usage seeder resets the project to myapp; put api back.
						await step(page, "the composer checkout is api / auth as branch");
						await permission(page);
						await terminal(page, false);
						await verifyComposer(page);
					},
				);
				const phone = await capture(
					ctx,
					{ width: 390, height: 844 },
					async (page) => {
						await seed(page, ctx);
						await permission(page);
						await verifyComposer(page);
					},
				);
				await compose(
					ctx,
					`<figure class="browser hero-desktop"><div class="chrome"><i></i><i></i><i></i><span>conduit · api / auth</span></div><img src="${desktop}"></figure><figure class="phone hero-phone"><img src="${phone}"></figure>`,
				);
			});
		},
	},
	{
		config: {
			name: "readme-continuity",
			outputFile: "readme/continuity-{theme}.png",
			viewport: { width: 480, height: 600 },
			animated: false,
			themes: ["light", "dark"],
		},
		async run(ctx) {
			await ctx.phase("matching desktop and phone drafts", async () => {
				const draft = async (page: Page) => {
					await seed(page, ctx);
					await page.locator("#input").fill(DRAFT);
					await expect(page.locator("#input")).toHaveValue(DRAFT);
					await verifyComposer(page);
				};
				const desktop = await capture(
					ctx,
					{ width: 920, height: 800 },
					draft,
					"#input-row",
				);
				const phone = await capture(
					ctx,
					{ width: 390, height: 844 },
					draft,
					"#input-row",
				);
				await compose(
					ctx,
					`<div class="drafts"><p>Typed at your desk</p><figure class="desktop-draft"><img src="${desktop}"></figure><p>Picked up on your phone</p><figure class="phone-draft"><img src="${phone}"></figure></div>`,
				);
			});
		},
	},
	{
		config: {
			name: "readme-craft",
			outputFile: "readme/craft-{theme}.png",
			viewport: { width: 480, height: 600 },
			animated: false,
			themes: ["light", "dark"],
		},
		async run(ctx) {
			await ctx.phase("phone terminal and flick keys", async () => {
				const phone = await capture(
					ctx,
					{ width: 390, height: 536 },
					async (page) => {
						await seed(page, ctx);
						await terminal(page, true);
					},
				);
				await compose(
					ctx,
					`<figure class="phone card-phone"><img src="${phone}"></figure>`,
				);
			});
		},
	},
	{
		config: {
			name: "readme-control",
			outputFile: "readme/control-{theme}.png",
			viewport: { width: 480, height: 600 },
			animated: false,
			themes: ["light", "dark"],
		},
		async run(ctx) {
			await ctx.phase("running Bash with steering and queue", async () => {
				const phone = await capture(
					ctx,
					{ width: 390, height: 536 },
					async (page) => {
						await seed(page, ctx, true);
						// The live step log appears with the turn's first activity, and
						// its tool rows render only once it is expanded.
						const relay = requireRelayControl(page);
						for (const type of ["thinking_delta", "thinking_stop"])
							relay.sendMessage({
								type,
								text: "The store swap is done; the auth tests decide the next step.",
								messageId: "composer-status-turn",
							});
						await step(page, "I expand the live turn step log");
						await step(page, "the mock relay runs Bash with pnpm test auth");
						await step(
							page,
							"the mock relay steers Use the staging database instead",
						);
						await step(page, "the mock relay queues Then open a draft PR");
						await expect(page.getByTestId("pending-input-state")).toHaveText([
							"Steering",
							"Queued",
						]);
						await expect(
							page.locator('[data-tool-id="composer-status-Bash"]'),
						).toContainText("pnpm test auth");
						await verifyComposer(page);
					},
				);
				await compose(
					ctx,
					`<figure class="phone card-phone"><img src="${phone}"></figure>`,
				);
			});
		},
	},
];
