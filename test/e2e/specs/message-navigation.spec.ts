import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

const sessionId = "rail-session";
const projectSlug = "e2e-replay";
const start = Date.parse("2026-10-27T10:00:00Z");
const summary = (index: number, inherited = false) => ({
	id: `user-${index}`,
	createdAt: start + index * 60_000,
	preview: `Prompt ${index}: check this part of the layout.`,
	isInherited: inherited,
});
const turn = (index: number) => [
	{
		_tag: "message",
		message: {
			id: `user-${index}`,
			role: "user",
			time: { created: start + index * 60_000 },
		},
	},
	{
		_tag: "part",
		messageId: `user-${index}`,
		sortOrder: 0,
		part: {
			id: `prompt-${index}`,
			type: "text",
			text: `Prompt ${index}: check this part of the layout.`,
		},
	},
	{
		_tag: "message",
		message: {
			id: `assistant-${index}`,
			role: "assistant",
			parentID: `user-${index}`,
			time: {
				created: start + index * 60_000 + 1000,
				completed: start + index * 60_000 + 2000,
			},
		},
	},
	{
		_tag: "part",
		messageId: `assistant-${index}`,
		sortOrder: 0,
		part: {
			id: `response-${index}`,
			type: "text",
			text: `Response ${index}. The message should remain readable when the panel is narrow.\n\nThis second paragraph gives each turn enough height to exercise scrolling.`,
		},
	},
];

for (const width of [1100, 390]) {
	test.describe(`message rail at ${width}px`, () => {
		test.use({ viewport: { width, height: 844 }, hasTouch: width === 390 });
		test("navigates loaded prompts without losing position during updates", async ({
			page,
			harness,
		}, testInfo) => {
			const rows = Array.from({ length: 60 }, (_, i) => turn(i + 1)).flat();
			const rpc = await mockWsRpc(page, {
				stubs: {
					ResolveSession: () => ({ projectSlug }),
					ViewSession: () => ({ ok: true }),
				},
				streams: {
					SubscribeSessionPromptIndex: (payload) => [
						{
							_tag: "snapshot",
							sequence: 1,
							rows: Array.from({ length: 60 }, (_, i) =>
								summary(i + 1, payload["sessionId"] === "rail-fork" && i < 30),
							),
						},
						{ _tag: "synchronized" },
					],
					SubscribeSessionDetail: () => [
						{ _tag: "snapshot", rows, sequence: 1, hasMore: false },
						{ _tag: "synchronized" },
					],
				},
			});
			await mockRelayWebSocket(page, {
				initMessages: [
					{
						type: "project_list",
						projects: [
							{
								slug: projectSlug,
								title: "Rail checks",
								folders: ["/tmp/e2e-replay"],
							},
						],
						current: projectSlug,
					},
					{
						type: "shell_snapshot",
						roots: true,
						sessions: [
							{
								id: sessionId,
								title: "Message navigation",
								status: "idle",
								updatedAt: start,
								messageCount: 120,
							},
							{
								id: "rail-fork",
								title: "Rail fork",
								status: "idle",
								updatedAt: start,
								messageCount: 120,
								forkedFrom: sessionId,
								forkPointMessageId: "assistant-30",
								forkPointTimestamp: start + 30 * 60_000 + 1000,
							},
						],
					},
				],
				responses: new Map(),
			});
			await page.goto(`${harness.relayBaseUrl}/s/${sessionId}`);
			const rail = page.getByRole("slider", { name: "User messages" });
			const scroller = page.locator("#messages");
			await expect(rail).toBeVisible();
			await expect(rail).toHaveAttribute("aria-valuemax", "60");
			await rail.focus();
			await page.keyboard.press("Home");
			await expect(rail).toHaveAttribute("aria-valuenow", "1");
			await expect(page.getByTestId("message-rail-preview")).toContainText(
				"Prompt 1:",
			);
			await expect(
				page.locator(".msg-user").filter({ hasText: "Prompt 1:" }),
			).toBeInViewport();
			const beforeStream = await scroller.evaluate((el) => el.scrollTop);
			rpc.sendChunk(
				"SubscribeSessionDetail",
				[
					{
						_tag: "upsert",
						sequence: 2,
						item: {
							_tag: "part",
							messageId: "assistant-60",
							sortOrder: 0,
							part: {
								id: "response-60",
								type: "text",
								text: "Live content grows.\n\n".repeat(30),
							},
						},
					},
				],
				sessionId,
			);
			await expect(page.locator(".msg-assistant").last()).toContainText(
				"Live content grows.",
			);
			await expect
				.poll(() => scroller.evaluate((el) => el.scrollTop))
				.toBe(beforeStream);
			await expect(page.getByTestId("jump-to-latest")).toBeVisible();
			await page.keyboard.press("End");
			await expect(rail).toHaveAttribute("aria-valuenow", "60");
			await expect(
				page.locator(".msg-user").filter({ hasText: "Prompt 60:" }),
			).toBeInViewport();
			await page.keyboard.press("ArrowUp");
			await expect(rail).toHaveAttribute("aria-valuenow", "59");
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("message-rail-preview")).toHaveCount(0);
			const box = await rail.boundingBox();
			if (!box) throw new Error("Rail has no bounds");
			const x = box.x + box.width / 2;
			const y = (fraction: number) => box.y + 12 + (box.height - 24) * fraction;
			if (width === 390) await page.touchscreen.tap(x, y(0.5));
			else await page.mouse.click(x, y(0.5));
			await expect(rail).toHaveAttribute("aria-valuenow", "31");
			const cdp =
				width === 390 ? await page.context().newCDPSession(page) : undefined;
			if (cdp)
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchStart",
					touchPoints: [{ x, y: y(0.2) }],
				});
			else {
				await page.mouse.move(x, y(0.2));
				await page.mouse.down();
			}
			await expect(rail).toHaveAttribute("aria-valuenow", "13");
			if (cdp)
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: y(0.7) }],
				});
			else await page.mouse.move(x, y(0.7), { steps: 8 });
			await expect(rail).toHaveAttribute("aria-valuenow", "42");
			await expect(
				page.locator(".msg-user").filter({ hasText: "Prompt 42:" }),
			).toBeInViewport();
			// Prepend while captured: the tick under the pointer keeps its identity.
			rpc.sendChunk(
				"SubscribeSessionPromptIndex",
				[{ _tag: "upsert", item: summary(0), sequence: 3 }],
				sessionId,
			);
			rpc.sendChunk(
				"SubscribeSessionDetail",
				turn(0).map((item) => ({ _tag: "upsert", item, sequence: 3 })),
				sessionId,
			);
			await expect(
				page.locator(".msg-user").filter({ hasText: "Prompt 0:" }),
			).toHaveCount(1);
			await expect(rail).toHaveAttribute("aria-valuemax", "60");
			if (cdp)
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: y(0.8) }],
				});
			else await page.mouse.move(x, y(0.8), { steps: 4 });
			await expect(page.getByTestId("message-rail-preview")).toContainText(
				"Prompt 48:",
			);
			if (cdp)
				await cdp.send("Input.dispatchTouchEvent", {
					type: "touchCancel",
					touchPoints: [],
				});
			else await page.mouse.up();
			await expect(rail).toHaveAttribute("aria-valuemax", "61");
			await rail.focus();
			await page.keyboard.press("Home");
			await expect(page.getByTestId("message-rail-preview")).toContainText(
				"Prompt 0:",
			);
			const preview = await page
				.getByTestId("message-rail-preview")
				.boundingBox();
			if (!preview) throw new Error("Preview has no bounds");
			expect(preview.x).toBeGreaterThanOrEqual(box.x + box.width);
			expect(preview.x + preview.width).toBeLessThanOrEqual(width);
			expect(preview.y).toBeGreaterThanOrEqual(0);
			expect(preview.y + preview.height).toBeLessThanOrEqual(844);
			await page.screenshot({
				path: testInfo.outputPath(`message-rail-${width}.png`),
			});
			await page.keyboard.press("Escape");
			await page.getByTestId("jump-to-latest").click();
			await expect(rail).toHaveAttribute("aria-valuenow", "61");
			await expect(page.getByTestId("jump-to-latest")).toBeHidden();
			await cdp?.detach();

			// Reflow above a target must not leave the cached marker positions stale.
			await page.setViewportSize({
				width: width === 390 ? 430 : 900,
				height: 700,
			});
			await rail.focus();
			await page.keyboard.press("Home");
			await page.keyboard.press("PageDown");
			await expect(rail).toHaveAttribute("aria-valuenow", "11");
			await expect(
				page.locator(".msg-user").filter({ hasText: "Prompt 10:" }),
			).toBeInViewport();

			// A replacement snapshot removes obsolete targets and preview state.
			rpc.sendChunk(
				"SubscribeSessionPromptIndex",
				[
					{ _tag: "snapshot", rows: [summary(1)], sequence: 4 },
					{ _tag: "synchronized" },
				],
				sessionId,
			);
			rpc.sendChunk(
				"SubscribeSessionDetail",
				[{ _tag: "snapshot", rows: turn(1), sequence: 4, hasMore: false }],
				sessionId,
			);
			await expect(rail).toHaveCount(0);
			await expect(page.getByTestId("message-rail-preview")).toHaveCount(0);

			await page.goto(`${harness.relayBaseUrl}/s/rail-fork`);
			await expect(rail).toHaveAttribute("aria-valuemax", "60");
			await rail.focus();
			await page.keyboard.press("Home");
			await expect(page.getByTestId("message-rail-preview")).toContainText(
				"Prompt 1:",
			);
			await expect(
				page.locator(".msg-user").filter({ hasText: "Prompt 1:" }),
			).toBeInViewport();
			// Selecting inherited history expands it; collapsing never removes its markers.
			await page.getByRole("button", { name: "Prior conversation" }).click();
			await expect(rail).toHaveAttribute("aria-valuemax", "60");
			await rail.focus();
			await page.keyboard.press("Home");
			await expect(page.getByTestId("message-rail-preview")).toContainText(
				"Prompt 1:",
			);
			await page.getByRole("button", { name: "Prior conversation" }).click();
			await expect(rail).toHaveAttribute("aria-valuemax", "60");
		});
	});
}
