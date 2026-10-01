import type { StepHandler } from "../runtime.js";
import { detailFeeds, requireRpcControl } from "./shared.js";

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
