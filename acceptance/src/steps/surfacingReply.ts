import { expect, type Locator, type Page } from "@playwright/test";
import { encodeReference } from "../../../src/lib/composer-references.js";
import { sendMockInputDraft } from "../../../test/e2e/helpers/rpc-mock.js";
import type { StepHandler } from "../runtime.js";
import {
	mockMessageSurfacing,
	requireRelayControl,
	requireRpcControl,
} from "./shared.js";

const SESSION = "sess-surfacing";
const expectedPreviews = new WeakMap<Page, string>();

function summary(page: Page): Locator {
	return page.getByTestId("surfacing-summary").filter({ visible: true });
}

async function selectWords(container: Locator, text: string) {
	await container.evaluate((body, excerpt) => {
		// A pointer press moves focus off the composer first; selecting while it keeps focus resets its caret.
		if (document.activeElement instanceof HTMLElement)
			document.activeElement.blur();
		const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node && !(node.textContent ?? "").includes(excerpt))
			node = walker.nextNode();
		if (!node) throw new Error(`Excerpt not found: ${excerpt}`);
		const start = (node.textContent ?? "").indexOf(excerpt);
		const range = document.createRange();
		range.setStart(node, start);
		range.setEnd(node, start + excerpt.length);
		window.getSelection()?.removeAllRanges();
		window.getSelection()?.addRange(range);
		document.dispatchEvent(new Event("selectionchange"));
		body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
	}, text);
}

/** Selects words in the turn summary's prose and replies with them, opening the summary first if needed. */
async function quoteRecap(page: Page, text: string) {
	if (!(await summary(page).isVisible()))
		await page
			.getByTestId("surfacing-summary-generate")
			.filter({ visible: true })
			.click();
	await selectWords(summary(page).locator(".summary-prose"), text);
	await summary(page).getByRole("button", { name: "Reply to this" }).click();
}

async function setCaret(page: Page, start: number, end = start) {
	await page.locator("#input").evaluate(
		(element, selection) => {
			const input = element as HTMLTextAreaElement;
			input.focus();
			input.setSelectionRange(selection.start, selection.end);
			input.dispatchEvent(new Event("select", { bubbles: true }));
		},
		{ start, end },
	);
}

async function tokenEnd(page: Page): Promise<number> {
	const value = await page.locator("#input").inputValue();
	const end = value.indexOf("×");
	if (end < 0)
		throw new Error("Composer is missing its visible reference token");
	// Past the × and the label's trailing narrow no-break space.
	return end + 2;
}

export const surfacingReplyHandlers: StepHandler[] = [
	{
		name: "reply to the surfaced card through its action or keyboard shortcut",
		match: /^I reply to the surfaced message with (Reply|r)$/,
		run: async ({ world, match }) => {
			const card = world.page.getByTestId("surfacing-msg-card");
			if (match[1] === "r") {
				await card.focus();
				await card.press("r");
			} else {
				await card.getByRole("button", { name: "Reply", exact: true }).click();
			}
			await expect(world.page.locator("#input")).toBeFocused();
		},
	},
	{
		name: "assert the card Reply pill follows the draft",
		match: /^the surfaced message's Reply is (not )?pressed$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("surfacing-msg-card")
					.getByRole("button", { name: "Reply", exact: true }),
			).toHaveAttribute("aria-pressed", match[1] ? "false" : "true");
		},
	},
	{
		name: "assert atomic reference chips",
		match: /^the composer has (\d+) reply token(?:s)? named (.+)$/,
		run: async ({ world, match }) => {
			const tokens = world.page.getByTestId("surfacing-ref-token");
			await expect(tokens).toHaveCount(Number(match[1]));
			await expect(tokens.first()).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert repeated chip labels hide distinct source payloads",
		match: /^the reply tokens have identical displayed labels$/,
		run: async ({ world }) => {
			const labels = await world.page
				.getByTestId("surfacing-ref-token")
				.allTextContents();
			expect(labels).toHaveLength(2);
			expect(labels[0]).toBe(labels[1]);
		},
	},
	{
		name: "assert another session does not inherit the reference draft",
		match: /^the composer has no reply tokens$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("surfacing-ref-token")).toHaveCount(
				0,
			);
		},
	},
	{
		name: "append free text without replacing a token",
		match: /^I append (.+) after the reply$/,
		run: async ({ world, match }) => {
			const input = world.page.locator("#input");
			await setCaret(world.page, (await input.inputValue()).length);
			await input.pressSequentially(match[1] ?? "");
		},
	},
	{
		name: "assert the exact plain text agent preview",
		match: /^the reply preview is (.+)$/,
		run: async ({ world, match }) => {
			const expected = (match[1] ?? "").replaceAll("\\n", "\n");
			const preview = world.page.getByTestId("surfacing-ref-preview");
			await preview
				.getByRole("button", { name: "What the agent receives" })
				.click();
			await expect
				.poll(() => preview.locator("pre").textContent())
				.toBe(expected);
			expectedPreviews.set(world.page, expected);
		},
	},
	{
		name: "assert submission and rendered transcript retain the exact preview",
		match:
			/^the submitted reply equals its exact preview and the transcript keeps that text$/,
		run: async ({ world }) => {
			const expected = expectedPreviews.get(world.page);
			if (expected === undefined)
				throw new Error("No reply preview was asserted");
			const submitted = await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "input.submit" &&
					request.payload["sessionId"] === SESSION,
			);
			expect(submitted.payload["text"]).toBe(expected);
			await requireRelayControl(world.page).sendMessages([
				{ type: "user_message", text: expected },
				{ type: "done", code: 0 },
			]);
			await expect
				.poll(() =>
					world.page
						.locator("#messages .msg-user")
						.last()
						.locator(".whitespace-pre-wrap")
						.textContent(),
				)
				.toBe(expected);
		},
	},
	{
		name: "select real text within the surfaced message",
		match: /^I select the surfaced words (.+)$/,
		run: async ({ world, match }) => {
			await selectWords(
				world.page.getByTestId("surfacing-msg-card").locator(".card-body"),
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert native selection and the phone selection action",
		match:
			/^the selection offers a native-selection-safe reply on (desktop|phone)$/,
		run: async ({ world, match }) => {
			const action = world.page.getByRole("button", { name: /Reply to this/ });
			await expect(action).toBeVisible();
			const selected = await world.page.evaluate(() =>
				window.getSelection()?.toString(),
			);
			expect(selected).toBe(
				"Recapture the phone baseline, or keep the old paint order?",
			);
			const selectable = await world.page
				.getByTestId("surfacing-msg-card")
				.locator(".card-body")
				.evaluate((element) => getComputedStyle(element).userSelect !== "none");
			expect(selectable).toBe(true);
			if (match[1] === "phone") {
				const bounds = await action.boundingBox();
				expect(bounds?.height).toBeGreaterThanOrEqual(32);
				await expect(world.page.getByText(/select words/i)).toBeHidden();
			}
		},
	},
	{
		name: "insert the selected message excerpt",
		match: /^I reply to the surfaced selection$/,
		run: async ({ world }) => {
			await world.page.getByRole("button", { name: /Reply to this/ }).click();
		},
	},
	{
		name: "assert short excerpt display retains no full quote in its chip",
		match: /^the reply excerpt chip clips (.+) to 24 characters$/,
		run: async ({ world, match }) => {
			const excerpt = match[1] ?? "";
			const token = world.page.getByTestId("surfacing-ref-token");
			await expect(token).toContainText(excerpt.slice(0, 24));
			await expect(token).not.toContainText(excerpt);
		},
	},
	{
		name: "quote words selected in the turn summary",
		match: /^I quote the recap words (.+)$/,
		run: async ({ world, match }) => {
			await quoteRecap(world.page, match[1] ?? "");
		},
	},
	{
		name: "reply to the message a recap citation opened",
		match: /^I reply to the cited message$/,
		run: async ({ world }) => {
			await world.page
				.getByTestId("surfacing-recap-reader")
				.getByRole("button", { name: "Reply", exact: true })
				.click();
		},
	},
	{
		name: "assert the cited message's Reply pill follows the draft",
		match: /^the cited message's Reply is (not )?pressed$/,
		run: async ({ world, match }) => {
			await expect(
				world.page
					.getByTestId("surfacing-recap-reader")
					.getByRole("button", { name: "Reply", exact: true }),
			).toHaveAttribute("aria-pressed", match[1] ? "false" : "true");
		},
	},
	{
		name: "assert a reply hands focus to the composer",
		match: /^the composer has focus$/,
		run: async ({ world }) => {
			await expect(world.page.locator("#input")).toBeFocused();
		},
	},
	{
		name: "assert the cited message closed once its reference landed",
		match: /^the cited message is closed$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("surfacing-recap-reader"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert the phone summary sheet gives the composer back",
		match: /^the summary is closed only on a phone$/,
		run: async ({ world }) => {
			const phone = (world.page.viewportSize()?.width ?? 1440) < 600;
			await expect(summary(world.page)).toHaveCount(phone ? 0 : 1);
			await expect(world.page.locator("#input")).toBeVisible();
		},
	},
	{
		name: "insert two references at independent positions among free text",
		match: /^I place a message reply and a recap reply among free text$/,
		run: async ({ world }) => {
			const input = world.page.locator("#input");
			await input.fill("Before  middle  after");
			await setCaret(world.page, "Before ".length);
			await world.page.getByTestId("surfacing-pin-2").click();
			await world.page
				.getByTestId("surfacing-msg-card")
				.getByRole("button", { name: "Reply", exact: true })
				.click();
			const value = await input.inputValue();
			await setCaret(world.page, value.indexOf(" after"));
			await quoteRecap(world.page, "The routing review is complete.");
		},
	},
	{
		name: "assert reference caret positions and surrounding free text",
		match: /^the composer keeps both references at their insertion carets$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("surfacing-ref-token")).toHaveCount(
				2,
			);
			const value = await world.page.locator("#input").inputValue();
			expect(value.indexOf("Before ")).toBe(0);
			expect(value.indexOf("#2")).toBeLessThan(value.indexOf(" middle "));
			expect(value.indexOf(" middle ")).toBeLessThan(value.indexOf("Recap"));
			expect(value.endsWith(" after")).toBe(true);
		},
	},
	{
		name: "remove references atomically through editing and their remove button",
		match: /^I remove the reply with (Backspace|x|partial selection)$/,
		run: async ({ world, match }) => {
			if (match[1] === "x") {
				await world.page.getByTestId("surfacing-ref-remove").click();
			} else {
				const end = await tokenEnd(world.page);
				await setCaret(world.page, match[1] === "Backspace" ? end : 1, end);
				await world.page
					.locator("#input")
					.press(match[1] === "Backspace" ? "Backspace" : "Delete");
			}
		},
	},
	{
		name: "edit a reference before exercising undo and redo",
		match: /^I edit the reply using (Backspace|selection replacement)$/,
		run: async ({ world, match }) => {
			const end = await tokenEnd(world.page);
			await setCaret(world.page, match[1] === "Backspace" ? end : 1, end);
			if (match[1] === "Backspace")
				await world.page.locator("#input").press("Backspace");
			else await world.page.keyboard.insertText("replacement");
		},
	},
	{
		name: "undo or redo the encoded composer draft",
		match: /^I (undo|redo) the composer edit$/,
		run: async ({ world, match }) => {
			await world.page
				.locator("#input")
				.press(match[1] === "undo" ? "Meta+z" : "Meta+Shift+z");
		},
	},
	{
		name: "assert no reference fragments survive removal",
		match: /^the composer contains no partial reply or preview$/,
		run: async ({ world }) => {
			await expect(world.page.getByTestId("surfacing-ref-token")).toHaveCount(
				0,
			);
			await expect(world.page.getByTestId("surfacing-ref-preview")).toHaveCount(
				0,
			);
			expect((await world.page.locator("#input").inputValue()).trim()).toBe("");
		},
	},
	{
		name: "assert left and right keys skip the entire token",
		match: /^arrow keys move across the whole reply token$/,
		run: async ({ world }) => {
			const end = await tokenEnd(world.page);
			await setCaret(world.page, end);
			const input = world.page.locator("#input");
			await input.press("ArrowLeft");
			expect(
				await input.evaluate(
					(element) => (element as HTMLTextAreaElement).selectionStart,
				),
			).toBe(0);
			await input.press("ArrowRight");
			expect(
				await input.evaluate(
					(element) => (element as HTMLTextAreaElement).selectionStart,
				),
			).toBe(end);
		},
	},
	{
		name: "assert existing draft transport carries the whole self-contained reference",
		match: /^the reply is included in the existing draft sync$/,
		run: async ({ world }) => {
			const synced = await requireRpcControl(world.page).waitForRequest(
				(request) =>
					request.tag === "SyncInputDraft" &&
					request.payload["sessionId"] === SESSION &&
					String(request.payload["text"]).includes("Keep the old paint order."),
			);
			const draft = synced.payload["text"];
			expect(typeof draft).toBe("string");
			expect(draft).not.toBe(await world.page.locator("#input").inputValue());
		},
	},
	{
		name: "reload a saved reference after disabling its source UI",
		match: /^surfacing is disabled and I reload the reply draft$/,
		run: async ({ world }) => {
			const previous = mockMessageSurfacing.get(world.page);
			if (!previous) throw new Error("Surfacing fixture is missing");
			mockMessageSurfacing.set(world.page, {
				...previous,
				enabled: false,
				active: false,
			});
			await world.page.reload();
			await expect(world.page.locator("#input")).toBeVisible();
			await expect(world.page.getByTestId("surfacing-msg-card")).toHaveCount(0);
		},
	},
	{
		name: "restore a self-contained reference from another device's draft",
		match: /^another device syncs a self-contained recap reply$/,
		run: async ({ world }) => {
			await sendMockInputDraft(world.page, SESSION, {
				from: "another-device",
				text: `${encodeReference({ kind: "recap-excerpt", text: "This source is available only on the other device." })}Please check it.`,
			});
		},
	},
];
