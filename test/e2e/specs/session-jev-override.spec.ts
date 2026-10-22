import { DEFAULT_CATEGORY_SET } from "../../../src/lib/contracts/category-set.js";
import { DEFAULT_MESSAGE_SURFACING_SETTINGS } from "../../../src/lib/contracts/message-surfacing.js";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

test.use({ recording: "chat-simple" });

for (const enabled of [true, false]) {
	test(`Jev override follows the session DTO with global ${enabled ? "on" : "off"}`, async ({
		page,
		relayUrl,
	}, testInfo) => {
		const sessionId = "sess-jev-override";
		const start = Date.now() - 60_000;
		const session = {
			id: sessionId,
			title: "Jev override",
			status: "idle",
			updatedAt: start,
			messageCount: 2,
			jev: null as "on" | "off" | null,
		};
		const messages: HistoryMessage[] = [
			{
				id: "user-jev",
				role: "user",
				time: { created: start },
				parts: [
					{ id: "request", type: "text", text: "Check the implementation" },
				],
			},
			{
				id: "assistant-jev",
				role: "assistant",
				time: { created: start + 1, completed: start + 3000 },
				parts: [
					{
						id: "jev-text",
						type: "text",
						text: "A finding in the implementation.",
						surfacingOrdinal: 1,
						surfacingProbabilities: { finding: 1 },
						time: { start, end: start + 1000 },
					},
					{
						id: "jev-thinking",
						type: "reasoning",
						text: "Checking the next step",
						time: { start: start + 1000, end: start + 2000 },
					},
					{
						id: "jev-final",
						type: "text",
						text: "Implementation checked.",
						surfacingOrdinal: 2,
						surfacingProbabilities: { finding: 1 },
						time: { start: start + 2000, end: start + 3000 },
					},
				],
			},
		];
		const control = await mockWsRpc(page, {
			stubs: {
				GetMessageSurfacing: () => ({
					...DEFAULT_MESSAGE_SURFACING_SETTINGS,
					enabled,
					active: enabled,
					summariesEnabled: false,
					turnsOpen: "expanded",
					key: { source: "stored", rejected: false },
				}),
				GetCategorySet: () => DEFAULT_CATEGORY_SET,
				SetSessionJev: ({ sessionId: id, jev }) => {
					expect(id).toBe(sessionId);
					session.jev = jev;
					control.upsertShellRow({ ...session });
					return { ok: true as const };
				},
			},
		});
		await mockRelayWebSocket(page, {
			initMessages: [
				{
					type: "mock_transcript_snapshot",
					id: sessionId,
					history: { messages, hasMore: false },
				},
				{ type: "shell_snapshot", roots: true, sessions: [session] },
				{ type: "status", sessionId, status: "idle" },
			],
			responses: new Map(),
		});
		await page.goto(new URL(`/s/${sessionId}`, relayUrl).href);
		const turn = page.locator(".turn-activity");
		await expect(turn).toHaveCount(1);
		const card = page.getByTestId("surfacing-card");
		await expect(card).toHaveCount(enabled ? 1 : 0);
		const menu = page.getByTestId("session-ctx-jev");
		const option = (id: string) =>
			page.locator(`[data-hold-menu-item="jev-${id}"]`);
		const openMenu = async (choice: string, detail: string) => {
			await page.getByTestId("session-bar-overflow").click();
			await expect(menu).toContainText(detail);
			await menu.click();
			await expect(option("default")).toHaveText(
				`Default (${enabled ? "on" : "off"})`,
			);
			await expect(option(choice)).toHaveAttribute("aria-current", "true");
			await expect(
				page.locator('[data-hold-menu-item^="jev-"][aria-current="true"]'),
			).toHaveCount(1);
		};
		const capture = async (name: string) => {
			const path = testInfo.outputPath(`${name}.png`);
			await page.screenshot({ path });
			await testInfo.attach(name, { path, contentType: "image/png" });
		};
		await openMenu("default", `Default · ${enabled ? "on" : "off"}`);
		await capture("jev-menu-default");
		await option(enabled ? "off" : "on").click();
		await expect
			.poll(() =>
				control
					.getRequests()
					.filter(({ tag }) => tag === "SetSessionJev")
					.map(({ payload }) => ({
						sessionId: payload["sessionId"],
						jev: payload["jev"],
					})),
			)
			.toEqual([{ sessionId, jev: enabled ? "off" : "on" }]);
		await expect(card).toHaveCount(enabled ? 0 : 1);
		if (enabled) {
			await turn.locator(".turn-activity-toggle").click();
			await expect(turn.locator(".step-log")).toBeVisible();
			await expect(
				turn.getByText("A finding in the implementation.", { exact: true }),
			).toBeVisible();
		}
		await capture(enabled ? "jev-off-plain-log" : "jev-on-card");
		await page.reload();
		await expect(card).toHaveCount(enabled ? 0 : 1);
		await openMenu(enabled ? "off" : "on", enabled ? "Off" : "On");
		await capture("jev-menu-override-after-reload");
		await option("default").click();
		await expect
			.poll(() =>
				control
					.getRequests()
					.filter(({ tag }) => tag === "SetSessionJev")
					.map(({ payload }) => payload["jev"]),
			)
			.toEqual([enabled ? "off" : "on", null]);
		await expect(card).toHaveCount(enabled ? 1 : 0);
		await capture(enabled ? "jev-default-card" : "jev-default-plain-log");
		// A server DTO update from another device must take effect without a menu action.
		session.jev = enabled ? "off" : "on";
		control.upsertShellRow({ ...session });
		await expect(card).toHaveCount(enabled ? 0 : 1);
		// The sidebar row menu offers the same choice as a keyboard-reachable radio group.
		await page
			.locator("#session-list .session-item")
			.first()
			.click({ button: "right" });
		const radio = (id: string) => page.getByTestId(`session-ctx-jev-jev-${id}`);
		await expect(radio(enabled ? "off" : "on")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await capture("jev-sidebar-menu");
		await radio("default").click();
		await expect
			.poll(() =>
				control
					.getRequests()
					.filter(({ tag }) => tag === "SetSessionJev")
					.map(({ payload }) => payload["jev"]),
			)
			.toEqual([enabled ? "off" : "on", null, null]);
		await expect(card).toHaveCount(enabled ? 1 : 0);
		await page.getByTestId("session-bar-overflow").click();
		await page.getByTestId("overflow-settings").click();
		await expect(page.getByTestId("settings-tab-surfacing")).toHaveText("Jev");
	});
}

for (const key of [
	{ source: "none", rejected: false },
	{ source: "stored", rejected: true },
] as const) {
	test(`Jev override is unavailable for ${key.source === "none" ? "missing" : "rejected"} key`, async ({
		page,
		relayUrl,
	}) => {
		await mockWsRpc(page, {
			stubs: {
				GetMessageSurfacing: () => ({
					...DEFAULT_MESSAGE_SURFACING_SETTINGS,
					enabled: true,
					active: false,
					key,
				}),
				GetCategorySet: () => DEFAULT_CATEGORY_SET,
			},
		});
		await page.goto(relayUrl);
		await page.getByTestId("session-bar-overflow").click();
		await expect(page.getByTestId("session-ctx-jev")).toHaveCount(0);
	});
}
