import type { Page } from "@playwright/test";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import type { StepHandler } from "../runtime.js";
import {
	createSessionDelays,
	detailFeeds,
	requireRpcControl,
} from "./shared.js";

/** What the pane showed on one animation frame after a send. */
type Frame = { t: number; skeleton: boolean; message: boolean };
const sendFrames = new WeakMap<Page, Frame[]>();
const sentTexts = new WeakMap<Page, string>();

export const transcriptFeedHandlers: StepHandler[] = [
	{
		name: "set transcript feed behaviour",
		match: /^the transcript feed will (synchronize|stall|hold|fail)$/,
		run: async ({ world, match }) => {
			const mode = match[1];
			if (
				mode !== "synchronize" &&
				mode !== "stall" &&
				mode !== "hold" &&
				mode !== "fail"
			)
				throw new Error(`Unknown transcript feed mode: ${mode ?? ""}`);
			detailFeeds.set(world.page, mode);
		},
	},
	{
		name: "assert transcript feed pill",
		match: /^the transcript feed pill reads (.+)$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("transcript-feed-pill")
				.getByText(match[1] ?? "", { exact: true })
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "assert transcript skeleton",
		match: /^the transcript shows a loading skeleton$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("transcript-skeleton")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "assert transcript inert",
		match: /^the transcript controls are inert$/,
		run: async ({ world }) => {
			await world.page
				.locator("#messages [inert]")
				.waitFor({ state: "attached", timeout: 2_000 });
		},
	},
	{
		name: "assert beginning of session hidden",
		match: /^the beginning of session marker is not shown$/,
		run: async ({ world }) => {
			const markers = await world.page
				.locator("#messages")
				.getByText("Beginning of session")
				.count();
			if (markers !== 0)
				throw new Error(
					"Beginning of session shown before the start is confirmed",
				);
		},
	},
	{
		name: "press transcript retry",
		match: /^I press Retry on the transcript$/,
		run: async ({ world }) => {
			const control = requireRpcControl(world.page);
			const isDetail = (request: { tag: string }) =>
				request.tag === "SubscribeSessionDetail";
			const newDetailRequest = (timeout: number) => {
				const seen = control.getRequests().length;
				return control.waitForRequest(
					(request) =>
						isDetail(request) && control.getRequests().indexOf(request) >= seen,
					timeout,
				);
			};
			// Right after an automatic retry the next one is at least 1s away, so
			// a resubscribe within 400ms of the click can only come from Retry.
			await newDetailRequest(15_000);
			control.detailFeed = "synchronize";
			const kicked = newDetailRequest(400);
			await world.page
				.getByTestId("transcript-feed-pill")
				.getByRole("button", { name: "Retry" })
				.click();
			await kicked;
		},
	},
	{
		name: "set session creation delay",
		match: /^session creation takes (\d+) ms$/,
		run: async ({ world, match }) => {
			createSessionDelays.set(world.page, Number(match[1]));
		},
	},
	{
		name: "send while sampling every frame",
		match:
			/^I send (.+) from the composer, watching the transcript for (\d+) ms$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const text = match[1] ?? "";
			const watchMs = Number(match[2]);
			sentTexts.set(page, text);
			await page.locator("#input").fill(text);
			// Sample from the click itself so a single bad frame is caught; a
			// polling assertion would miss a skeleton that flashes and goes. A
			// string, because tsx's __name helper does not exist in the page.
			await page.evaluate(`(() => {
				const text = ${JSON.stringify(text)};
				const frames = (window.__sendFrames = []);
				let start;
				const sample = () => {
					start ??= performance.now();
					const skeleton = document.querySelector('[data-testid="transcript-skeleton"]');
					frames.push({
						t: Math.round(performance.now() - start),
						skeleton: !!skeleton && Number(getComputedStyle(skeleton).opacity) > 0,
						message: !!document.querySelector("#messages")?.textContent?.includes(text),
					});
					if (performance.now() - start < ${watchMs}) requestAnimationFrame(sample);
				};
				document.querySelector("#send").addEventListener("click", () => requestAnimationFrame(sample), { once: true });
			})()`);
			await page.locator("#send").click();
			await page.waitForTimeout(watchMs + 100);
			sendFrames.set(
				page,
				(await page.evaluate("window.__sendFrames")) as Frame[],
			);
		},
	},
	{
		name: "assert sent message shown at once without skeleton",
		match:
			/^the sent message showed within (\d+) ms and stayed, with no loading skeleton$/,
		run: async ({ world, match }) => {
			const frames = sendFrames.get(world.page) ?? [];
			const timeline = JSON.stringify(
				frames.filter(
					(f, i) =>
						i === 0 ||
						f.skeleton !== frames[i - 1]?.skeleton ||
						f.message !== frames[i - 1]?.message,
				),
			);
			const shownAt = frames.findIndex((f) => f.message);
			if (shownAt === -1 || (frames[shownAt]?.t ?? 0) > Number(match[1]))
				throw new Error(`Sent message was not shown in time: ${timeline}`);
			if (frames.slice(shownAt).some((f) => !f.message))
				throw new Error(`Sent message blinked out: ${timeline}`);
			if (frames.some((f) => f.skeleton))
				throw new Error(`Loading skeleton painted over the send: ${timeline}`);
		},
	},
	{
		name: "server places the first send",
		match: /^the server places the sent message in the new session$/,
		run: async ({ world }) => {
			const text = sentTexts.get(world.page) ?? "";
			requireRpcControl(world.page).setDetailRows(
				"sess-first-send",
				detailRowsOf({
					id: "msg-first-send",
					role: "user",
					time: { created: 1 },
					parts: [{ id: "part-first-send", type: "text", text }],
				}),
			);
		},
	},
	{
		name: "assert sent message shown once",
		match: /^the transcript shows the sent message exactly once$/,
		run: async ({ world }) => {
			const text = sentTexts.get(world.page) ?? "";
			const copies = world.page
				.locator("#messages")
				.getByText(text, { exact: true });
			await copies.first().waitFor({ state: "visible", timeout: 5_000 });
			// The placed row and the draft's copy swap in one frame; give a
			// leftover copy time to show before counting.
			await world.page.waitForTimeout(200);
			const count = await copies.count();
			if (count !== 1)
				throw new Error(`Expected the sent message once, found ${count}`);
		},
	},
	{
		name: "assert transcript live",
		match: /^the transcript is live$/,
		run: async ({ world }) => {
			const page = world.page;
			await page
				.getByTestId("transcript-feed-pill")
				.waitFor({ state: "detached", timeout: 5_000 });
			await page
				.getByTestId("transcript-skeleton")
				.waitFor({ state: "detached", timeout: 2_000 });
			await page
				.locator("#messages [inert]")
				.waitFor({ state: "detached", timeout: 2_000 });
		},
	},
];
