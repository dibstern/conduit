import { DatabaseSync } from "node:sqlite";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect, Exit, Layer, Scope } from "effect";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type { ReplayHarness } from "../helpers/e2e-harness.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const IDLE_WINDOW_MS = 3 * 86_400_000;

/** A typed WS RPC client on the relay, open until `close`. */
async function connectRpc(relayPort: number) {
	const scope = Effect.runSync(Scope.make());
	const protocol = RpcClient.layerProtocolSocket().pipe(
		Layer.provide(
			Socket.layerWebSocket(`ws://127.0.0.1:${relayPort}/rpc`).pipe(
				Layer.provide(Socket.layerWebSocketConstructorGlobal),
			),
		),
		Layer.provide(RpcSerialization.layerJson),
	);
	const client = await Effect.runPromise(
		Layer.buildWithScope(protocol, scope).pipe(
			Effect.flatMap((context) =>
				RpcClient.make(WsRpcGroup).pipe(Effect.provide(context)),
			),
			Scope.extend(scope),
		),
	);
	return {
		client,
		close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
	};
}

function lastMessageAt(harness: ReplayHarness, sessionId: string): number {
	const db = new DatabaseSync(harness.eventsDbPath, { readOnly: true });
	try {
		return Number(
			db
				.prepare("SELECT last_message_at FROM sessions WHERE id = ?")
				.get(sessionId)?.["last_message_at"],
		);
	} finally {
		db.close();
	}
}

test("auto-settle toggle and idle window survive reload", async ({
	page,
	relayUrl,
}) => {
	await gotoRelay(page, relayUrl);
	const row = page.locator("#session-list .session-item").first();
	await expect(row).toBeVisible();
	await row.click({ button: "right" });
	const toggle = page.getByTestId("session-ctx-auto-settle");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await toggle.click();
	await row.click({ button: "right" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.reload();
	await expect(row).toBeVisible();
	await row.click({ button: "right" });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");

	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
	await page.getByTestId("settings-tab-general").click();
	const select = page.getByTestId("settings-auto-settle-select");
	await expect(select).toHaveValue("3");
	await select.selectOption("7");
	await expect(select).toBeEnabled();
	await page.getByTestId("settings-close-btn").click();
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
	await page.getByTestId("settings-tab-general").click();
	await expect(select).toHaveValue("7");
	await page.reload();
	await page.getByTestId("session-bar-overflow").click();
	await page.getByTestId("overflow-settings").click();
	await page.getByTestId("settings-tab-general").click();
	await expect(select).toHaveValue("7");
});

test("the auto-settle outlook reads the same with or without a viewer", async ({
	page,
	relayUrl,
	harness,
}) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.sendMessage("Ping");
	const chat = new ChatPage(page);
	await chat.waitForAssistantMessage();
	await chat.waitForStreamingComplete();
	const sessionId = harness.projectUrl.replace(/^\/s\//, "");
	const { client, close } = await connectRpc(harness.relayPort);
	try {
		const read = () =>
			Effect.runPromise(client.GetSessionAutoSettleOutlook({ sessionId }));
		const sweep = (now: number) =>
			Effect.runPromise(harness.stack.settleIdleSessions(IDLE_WINDOW_MS, now));

		// An unread reply holds settlement back; reading it lets the clock run.
		await Effect.runPromise(client.MarkSessionRead({ sessionId }));
		// The replayed provider restamps the turn with its recorded, long-past
		// times a moment after the reply, leaving the last message as the
		// session's last activity.
		const at = lastMessageAt(harness, sessionId) + IDLE_WINDOW_MS;
		const scheduled = { kind: "scheduled", at };
		await expect.poll(read).toEqual(scheduled);
		// The open page holds the sweep back, but not the outlook.
		expect(await sweep(at + 1)).toBe(0);

		await Effect.runPromise(
			client.SetSessionPinned({ sessionId, pinned: true }),
		);
		expect(await read()).toEqual({ kind: "paused", reason: "pinned" });
		await Effect.runPromise(
			client.SetSessionPinned({ sessionId, pinned: false }),
		);

		await Effect.runPromise(
			client.SetAutoSettleSetting({ autoSettleAfterDays: null }),
		);
		expect(await read()).toEqual({ kind: "never" });
		await Effect.runPromise(
			client.SetAutoSettleSetting({ autoSettleAfterDays: 3 }),
		);

		expect(
			await Effect.runPromise(
				client.SetSessionAutoSettle({ sessionId, disabled: true }),
			),
		).toEqual({ kind: "off" });
		expect(await read()).toEqual({ kind: "off" });
		expect(
			await Effect.runPromise(
				client.SetSessionAutoSettle({ sessionId, disabled: false }),
			),
		).toEqual(scheduled);

		await page.close();
		expect(await read()).toEqual(scheduled);
		await expect.poll(() => sweep(at + 1)).toBe(1);
		expect(await read()).toEqual({ kind: "settled" });

		await Effect.runPromise(
			client.SetSessionSettled({ sessionId, settled: false }),
		);
		expect(await read()).toEqual({
			kind: "paused",
			reason: "awaiting-activity",
		});

		const missing = await Effect.runPromise(
			Effect.flip(
				client.GetSessionAutoSettleOutlook({ sessionId: "ses_missing" }),
			),
		);
		expect(missing).toMatchObject({ code: "unknown-session" });
	} finally {
		await close();
	}
});

test.describe("forked session", () => {
	test.use({ recording: "fork-session" });

	test("a fork is a root session, so it settles like its source", async ({
		page,
		relayUrl,
		harness,
	}) => {
		const app = new AppPage(page);
		const chat = new ChatPage(page);
		await app.goto(relayUrl);
		for (const word of ["alpha", "beta"]) {
			await app.sendMessage(
				word === "alpha"
					? "Remember the word 'alpha'. Reply with only: ok, remembered."
					: "Now remember 'beta' too. Reply with only: ok, remembered.",
			);
			await chat.waitForAssistantMessage();
			await chat.waitForStreamingComplete();
		}
		const sessionId = harness.projectUrl.replace(/^\/s\//, "");
		const { client, close } = await connectRpc(harness.relayPort);
		try {
			const fork = await Effect.runPromise(
				client.ForkSession({ sessionId, originId: "e2e-auto-settle-fork" }),
			);
			expect(fork.forkedFrom).toBe(sessionId);
			const read = (id: string) =>
				Effect.runPromise(
					client.GetSessionAutoSettleOutlook({ sessionId: id }),
				);
			expect(await read(sessionId)).not.toEqual({ kind: "off" });
			expect(await read(fork.sessionId)).not.toEqual({ kind: "off" });
			expect(
				await Effect.runPromise(
					client.SetSessionAutoSettle({
						sessionId: fork.sessionId,
						disabled: true,
					}),
				),
			).toEqual({ kind: "off" });
		} finally {
			await close();
		}
	});
});

test.describe("phone session state chip", () => {
	test.use({ viewport: { width: 375, height: 740 } });

	test("settlement, auto-settle and un-settle stay in sync with the list", async ({
		page,
		relayUrl,
	}) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const row = page.locator("#session-list .session-item").first();
		await expect(row).toBeVisible();
		const id = await row.getAttribute("data-session-id");
		const liveRow = page.locator(`#session-list [data-session-id="${id}"]`);
		const shelfRow = page.locator(
			`#settled-shelf-rows [data-session-id="${id}"]`,
		);
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-settle").click();
		await page.getByTestId("settled-shelf-toggle").click();
		await shelfRow.click();

		const chip = page.getByTestId("session-bar-state-chip");
		await expect(chip).toHaveAttribute("data-state", "settled");
		await expect(chip).toContainText("Settled");
		await expect(page.locator("#input")).toHaveAttribute(
			"placeholder",
			"Message to un-settle…",
		);
		await chip.click();
		const autoSettle = page.getByTestId("session-bar-auto-settle");
		await expect(autoSettle).toHaveAttribute("aria-checked", "true");
		await autoSettle.click();
		await chip.click();
		await expect(autoSettle).toHaveAttribute("aria-checked", "false");
		await page.keyboard.press("Escape");
		await page.getByTestId("session-bar-back").click();
		await shelfRow.click({ button: "right" });
		await expect(page.getByTestId("session-ctx-auto-settle")).toHaveAttribute(
			"aria-checked",
			"false",
		);
		await page.keyboard.press("Escape");
		await shelfRow.click();
		await chip.click();
		await page.getByTestId("session-bar-unsettle").click();
		await expect(chip).toHaveCount(0);
		await page.getByTestId("session-bar-back").click();
		await expect(liveRow).toBeVisible();
	});

	test("snooze time and Wake now", async ({ page, relayUrl }) => {
		await gotoRelay(page, new URL("/", relayUrl).toString());
		const row = page.locator("#session-list .session-item").first();
		await expect(row).toBeVisible();
		const id = await row.getAttribute("data-session-id");
		await row.click({ button: "right" });
		await page.getByTestId("session-ctx-snooze").click();
		await page.getByTestId("snooze-option-1h").click();
		await page.getByTestId("snoozed-shelf-toggle").click();
		await page.locator(`#snoozed-shelf-rows [data-session-id="${id}"]`).click();
		const chip = page.getByTestId("session-bar-state-chip");
		await expect(chip).toHaveAttribute("data-state", "snoozed");
		await expect(chip).toContainText(/\d{1,2}:\d{2}/);
		await expect(page.locator("#input")).toHaveAttribute(
			"placeholder",
			"Message to wake…",
		);
		await chip.click();
		await page.getByTestId("session-bar-wake").click();
		await expect(chip).toHaveCount(0);
		await page.getByTestId("session-bar-back").click();
		await expect(
			page.locator(`#session-list [data-session-id="${id}"]`),
		).toBeVisible();
	});
});
