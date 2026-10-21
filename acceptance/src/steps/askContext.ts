import { expect, type Page } from "@playwright/test";
import { Stream } from "effect";
import { serializeReferences } from "../../../src/lib/composer-references.js";
import type { AskExplanation } from "../../../src/lib/contracts/ask-explanation.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import { isRecord } from "../../../src/lib/utils.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	mockMessageSurfacing,
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";
import { surfacingHistory } from "./surfacingCard.js";

const SESSION = "sess-surfacing";
const SETUP =
	"The visual suite caught a 2px drop on the phone sidebar only; desktop is unchanged. The unread badge now paints before the first frame. Recapture the baseline and accept the new spacing, or hold the badge back one frame so nothing moves. I lean recapture, since the new spacing matches desktop.";
const QUESTION =
	"The phone sidebar baseline shifts 2px because the unread badge now paints before the first frame. Recapture it, or keep the old paint order? I'll carry on with the deep link meanwhile.";
const explanation: AskExplanation = {
	model: "sonnet",
	soFar:
		"You asked the agent to move the session list onto the new live-update connection and remove the old code.",
	whatCameUp:
		"On phones, the sidebar's list now sits 2 pixels lower than in its saved screenshot [#1], because the unread count shows up straight away and takes its space.",
	options: [
		{
			label: "Keep the new look",
			explanation:
				"The agent replaces the saved screenshot. On phones the list stays 2px lower, which matches desktop.",
			recommended: true,
		},
		{
			label: "Keep it as it was",
			explanation:
				"The unread count waits a split second before it appears, so nothing moves. Counts show up slightly later on open.",
			recommended: false,
		},
	],
	unanswered:
		"If you don't answer, the agent keeps working on push links, and the phone screenshot test stays failing until you decide [#2].",
};
const calls = (page: Page) =>
	requireRpcControl(page)
		.getRequests()
		.filter(({ tag }) => tag === "ExplainAsk");

export const askContextHandlers: StepHandler[] = [
	{
		name: "choose an Ask reply action",
		match: /^I choose the Ask action (Reply|Reply with this|Something else)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			// Plain Reply is the card's own toggle; the Ask context adds only the Explain flow's replies.
			if (match[1] === "Reply") {
				await page
					.getByTestId("surfacing-msg-card")
					.getByRole("button", { name: "Reply", exact: true })
					.click();
				return;
			}
			await page.getByTestId("ask-explain").click();
			await expect(page.getByTestId("ask-explanation")).toBeVisible();
			await page
				.getByTestId("ask-context")
				.getByRole("button", {
					name: `↩ ${match[1]}${match[1] === "Something else" ? "…" : ""}`,
					exact: true,
				})
				.first()
				.click();
		},
	},
	{
		name: "assert Ask reply only changes the composer draft",
		match:
			/^the composer contains the Ask reply (.+) followed by (.+) without sending$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const expected = `${match[1]}: "${QUESTION}"\n\n${(match[2] ?? "").replaceAll("\\n", "\n")}`;
			const token = page.getByTestId("surfacing-ref-token");
			await expect(token).toHaveCount(1);
			await expect(token).toContainText("#2 Ask");
			await expect(page.locator("#input")).toBeFocused();
			const rpc = requireRpcControl(page);
			const synced = await rpc.waitForRequest(
				(request) =>
					request.tag === "SyncInputDraft" &&
					isRecord(request.payload["key"]) &&
					request.payload["key"]["session"] === SESSION &&
					serializeReferences(String(request.payload["text"])) === expected,
			);
			expect(synced.payload["key"]).toEqual({ session: SESSION });
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "input.submit"),
			).toHaveLength(0);
		},
	},
	{
		name: "set Ask context theme and summary model",
		match: /^Ask context uses the (dark|light) theme with summaries (on|off)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const previous = mockMessageSurfacing.get(page);
			if (!previous) throw new Error("Seed surfacing first");
			const status = {
				...previous,
				recap: {
					model: match[2] === "off" ? ("off" as const) : ("sonnet" as const),
					when: "on-request" as const,
				},
			};
			mockMessageSurfacing.set(page, status);
			requireRpcControl(page).setStubs({
				GetMessageSurfacing: () => status,
				ListRecaps: () => [],
				SubscribeRecaps: () =>
					Stream.succeed({ versions: [], generating: false, error: null }),
			});
			await page.evaluate(
				(theme) => localStorage.setItem("conduit-theme", theme),
				match[1] ?? "dark",
			);
			await page.reload();
		},
	},
	{
		name: "open Ask with or without preceding setup",
		match: /^the Ask session has (a setup|no setup|a failing explanation)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const noSetup = match[1] === "no setup";
			let failNext = match[1] === "a failing explanation";
			const rpc = requireRpcControl(page);
			rpc.setStubs({
				ExplainAsk: ({ sessionId, turnId, partId }) => {
					expect({ sessionId, turnId, partId }).toEqual({
						sessionId: SESSION,
						turnId: "surfacing-user",
						partId: "surfacing-part-2",
					});
					if (failNext) {
						failNext = false;
						throw new WsRpcError({ message: "Claude is not signed in." });
					}
					return noSetup
						? {
								...explanation,
								whatCameUp:
									"The agent is asking whether to keep the new look or preserve the earlier spacing [#2].",
							}
						: explanation;
				},
			});
			rpc.setDetailRows(
				SESSION,
				surfacingHistory("short")
					.map((message) => ({
						...message,
						parts: message.parts
							?.filter(
								(part) =>
									!noSetup ||
									(part.surfacingOrdinal !== 1 &&
										part.id !== "surfacing-tool-1"),
							)
							.map((part) =>
								part.surfacingOrdinal === 1
									? {
											...part,
											text: SETUP,
											surfacingProbabilities: { finding: 0.6 },
										}
									: part.surfacingOrdinal === 2
										? { ...part, text: QUESTION }
										: part,
							),
					}))
					.flatMap(detailRowsOf),
			);
			setSessionRowStatus(page, SESSION, "idle", {
				title: "Ask context acceptance",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(page, SESSION);
			await page.getByTestId("surfacing-ask-chip").click();
			await expect(page.getByTestId("surfacing-msg-card")).toHaveAttribute(
				"data-ordinal",
				"2",
			);
		},
	},
	{
		name: "assert free setup quote and actions",
		match:
			/^the Ask quotes the preceding setup with Explain options and Reply$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("ask-setup")).toContainText(SETUP);
			await expect(world.page.getByTestId("ask-setup-jump")).toContainText(
				"#1",
			);
			await expect(world.page.getByTestId("ask-explain")).toHaveText(
				"✦ Explain options",
			);
			await expect(
				world.page
					.getByTestId("surfacing-msg-card")
					.getByRole("button", { name: "Reply", exact: true }),
			).toBeVisible();
			await expect(
				world.page
					.getByTestId("ask-context")
					.getByRole("button", { name: "↩ Reply", exact: true }),
			).toHaveCount(0);
			expect(calls(world.page)).toHaveLength(0);
		},
	},
	{
		name: "jump from setup quote",
		match: /^I jump to the Ask setup$/,
		run: async ({ world }) => {
			await world.page.getByTestId("ask-setup-jump").click();
		},
	},
	{
		name: "assert direct below-level setup destination",
		match: /^the quoted setup opens below the chosen surfacing level$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-msg-card"),
			).toHaveAttribute("data-ordinal", "1");
			await expect(world.page.getByTestId("surfacing-msg-card")).toContainText(
				SETUP,
			);
			await expect(
				world.page
					.getByTestId("surfacing-level")
					.getByRole("radio", { name: /Balanced/ }),
			).toBeChecked();
		},
	},
	{
		name: "return to Ask",
		match: /^I return to the Ask$/,
		run: async ({ world }) => {
			await world.page.getByTestId("ask-back").click();
			await expect(
				world.page.getByTestId("surfacing-msg-card"),
			).toHaveAttribute("data-ordinal", "2");
		},
	},
	{
		name: "request Ask explanation",
		match: /^I explain the Ask options$/,
		run: async ({ world }) => {
			await world.page.getByTestId("ask-explain").click();
		},
	},
	{
		name: "assert plain words and citations",
		match:
			/^the Ask explains So far and What came up with cited options( after a retry)?$/,
		run: async ({ world, match }) => {
			const box = world.page.getByTestId("ask-explanation");
			for (const copy of [
				"✦ In plain words",
				"Sonnet",
				"So far",
				"What came up",
				"Keep the new look",
				"Keep it as it was",
				"Agent leans this way",
				"If you don't answer",
			])
				await expect(box).toContainText(copy);
			await expect(
				box.getByRole("button", { name: "↩ Reply with this" }),
			).toHaveCount(2);
			await expect(box.getByTestId("ask-cite-1")).toBeVisible();
			await expect(box.getByTestId("ask-cite-2")).toBeVisible();
			expect(calls(world.page)).toHaveLength(match[1] ? 2 : 1);
		},
	},
	{
		name: "follow Ask explanation citation",
		match: /^I follow Ask citation #(\d+)$/,
		run: async ({ world, match }) => {
			await world.page.getByTestId(`ask-cite-${match[1]}`).click();
		},
	},
	{
		name: "assert explanation survives navigation without payment",
		match: /^the same Ask explanation is retained without another call$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("ask-explanation")).toBeVisible();
			expect(calls(world.page)).toHaveLength(1);
		},
	},
	{
		name: "assert no setup primary layout",
		match: /^the Ask has no setup and Explain options is primary$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("ask-setup")).toHaveText(
				"No earlier explanation found.",
			);
			await expect(world.page.getByTestId("ask-setup-jump")).toHaveCount(0);
			await expect(world.page.getByTestId("ask-explain")).toHaveAttribute(
				"data-primary",
				"true",
			);
			expect(calls(world.page)).toHaveLength(0);
		},
	},
	{
		name: "assert failed explanation keeps setup and permits retry",
		match: /^the Ask keeps its setup and offers an explanation retry$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("ask-setup")).toContainText(SETUP);
			await expect(
				world.page.getByTestId("ask-context").getByRole("alert"),
			).toContainText("Claude is not signed in.");
			await expect(world.page.getByTestId("ask-explain")).toHaveText(
				"✦ Try again",
			);
		},
	},
	{
		name: "assert summary Off prevents paid explanation",
		match: /^the Ask keeps its quote while explaining is disabled$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("ask-setup")).toContainText(SETUP);
			await expect(world.page.getByTestId("ask-explain")).toBeDisabled();
			expect(calls(world.page)).toHaveLength(0);
		},
	},
];
