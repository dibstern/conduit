import { expect, type JSHandle, type Page } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

const sources = {
	"a flowchart diagram": "flowchart LR\n  Plan --> Build --> Ship",
	"a broken flowchart diagram": "flowchart LR\n  Plan -->|oops Build",
	"an unknown diagram type": "notadiagram\n  foo",
} as const;
type DiagramFixture = keyof typeof sources;
const fixturePattern = Object.keys(sources).join("|");

const STREAM_ID = "assistant-diagram-stream";
const seededSources = new WeakMap<Page, string>();
const noted = new WeakMap<Page, { svg: JSHandle<Element>; fill: string }>();

const markdown = (source: string) =>
	`Here is the plan:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n`;
const lastAssistant = (page: Page) =>
	page.locator("#messages .msg-assistant").last();
const diagram = (page: Page) => lastAssistant(page).locator("[data-diagram]");
const nodeFill = (svg: Element) => {
	const shape = svg.querySelector(".pele-node rect");
	return shape ? getComputedStyle(shape).fill : "";
};

export const assistantDiagramsHandlers: StepHandler[] = [
	{
		name: "seed a finished assistant message with a diagram",
		match: new RegExp(
			`^the transcript contains a finished assistant message with (${fixturePattern})$`,
		),
		run: async ({ world, match }) => {
			const page = world.page;
			const source = sources[match[1] as DiagramFixture];
			seededSources.set(page, source);
			const messages: HistoryMessage[] = [
				{
					id: "diagram-user",
					role: "user",
					time: { created: PINNED_CLOCK_MS },
					parts: [
						{ id: "diagram-user-text", type: "text", text: "Draw the plan" },
					],
				},
				{
					id: "diagram-assistant",
					role: "assistant",
					parentID: "diagram-user",
					time: {
						created: PINNED_CLOCK_MS + 1,
						completed: PINNED_CLOCK_MS + 2,
					},
					parts: [
						{
							id: "diagram-assistant-text",
							type: "text",
							text: markdown(source),
						},
					],
				},
			];
			requireRelayControl(page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId: new URL(page.url()).pathname.split("/")[2],
				history: { messages, hasMore: false },
			});
			await expect(lastAssistant(page)).toContainText("Here is the plan:");
		},
	},
	{
		name: "stream an assistant message with a diagram",
		match:
			/^the mock relay streams an assistant message with a flowchart diagram$/,
		run: async ({ world }) => {
			const source = sources["a flowchart diagram"];
			seededSources.set(world.page, source);
			requireRelayControl(world.page).sendMessage({
				type: "delta",
				text: markdown(source),
				messageId: STREAM_ID,
			});
			await expect(lastAssistant(world.page)).toContainText(
				"Here is the plan:",
			);
		},
	},
	{
		name: "finish the streamed assistant message",
		match: /^the mock relay finishes the assistant message$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "done",
				messageId: STREAM_ID,
				code: 0,
			});
		},
	},
	{
		name: "assert diagram drawn",
		match: /^the assistant message draws the diagram$/,
		run: async ({ world }) => {
			const svg = diagram(world.page).locator("svg").first();
			await expect(svg).toBeVisible();
			await expect(svg).toContainText("Build");
			await expect(diagram(world.page).locator(".pele-error")).toHaveCount(0);
		},
	},
	{
		name: "assert streaming mermaid code block",
		match:
			/^the streaming message shows the diagram source in a mermaid code block$/,
		run: async ({ world }) => {
			const pre = lastAssistant(world.page).locator("pre", {
				has: world.page.locator("code.language-mermaid"),
			});
			await expect(pre.locator(".code-header")).toContainText("mermaid");
			await expect(pre.locator("code")).toContainText(
				"Plan --> Build --> Ship",
			);
		},
	},
	{
		name: "assert no diagram drawn",
		match: /^no diagram is drawn$/,
		run: async ({ world }) => {
			// Give a wrongly eager mount the chance to show itself.
			await world.page.waitForTimeout(500);
			await expect(
				lastAssistant(world.page).locator("[data-diagram]"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert no mermaid code block",
		match: /^no mermaid code block is left$/,
		run: async ({ world }) => {
			await expect(
				lastAssistant(world.page).locator("code.language-mermaid"),
			).toHaveCount(0);
		},
	},
	{
		name: "note diagram and node colour",
		match: /^I note the drawn diagram and its node colour$/,
		run: async ({ world }) => {
			const svg = await diagram(world.page)
				.locator("svg")
				.first()
				.elementHandle();
			if (!svg) throw new Error("No drawn diagram to note");
			const fill = await svg.evaluate(nodeFill);
			if (!fill) throw new Error("The drawn diagram has no filled node");
			noted.set(world.page, { svg, fill });
		},
	},
	{
		name: "assert noted diagram recoloured",
		match:
			/^the noted diagram is still on screen with a different node colour$/,
		run: async ({ world }) => {
			const before = noted.get(world.page);
			if (!before) throw new Error("No diagram was noted");
			await expect
				.poll(() => before.svg.evaluate(nodeFill))
				.not.toBe(before.fill);
			const current = await diagram(world.page)
				.locator("svg")
				.first()
				.elementHandle();
			const same = await before.svg.evaluate(
				(svg, other) => svg.isConnected && svg === other,
				current,
			);
			if (!same) throw new Error("The theme switch redrew the diagram");
		},
	},
	{
		name: "assert diagram error position",
		match:
			/^the diagram error names line (\d+) and puts a caret under column (\d+)$/,
		run: async ({ world, match }) => {
			const error = diagram(world.page).locator(".pele-error");
			await expect(error).toContainText(`line ${match[1]}`);
			// The caret line has column - 1 dashes before the caret.
			await expect(error).toContainText(
				`\n${"-".repeat(Number(match[2]) - 1)}^`,
			);
		},
	},
	{
		name: "assert diagram error text",
		match: /^the diagram error says (.+)$/,
		run: async ({ world, match }) => {
			await expect(diagram(world.page).locator(".pele-error")).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "assert diagram source below error",
		match: /^the diagram source is shown below the error$/,
		run: async ({ world }) => {
			const page = world.page;
			const source = diagram(page).locator("pre code");
			await expect(source).toHaveText(seededSources.get(page) ?? "");
			const errorBox = await diagram(page).locator(".pele-error").boundingBox();
			const sourceBox = await source.boundingBox();
			if (
				!errorBox ||
				!sourceBox ||
				sourceBox.y < errorBox.y + errorBox.height
			) {
				throw new Error("The diagram source is not below the error");
			}
		},
	},
	{
		name: "click the drawn diagram twice",
		match: /^I click the drawn diagram twice$/,
		run: async ({ world }) => {
			const svg = diagram(world.page).locator("svg").first();
			await svg.click();
			await svg.click();
		},
	},
	{
		name: "press Enter on the drawn diagram twice",
		match: /^I press Enter on the drawn diagram twice$/,
		run: async ({ world }) => {
			// The inline diagram has nothing focusable yet, so send the key from inside it.
			const svg = diagram(world.page).locator("svg").first();
			for (const _ of [1, 2]) {
				await svg.dispatchEvent("keydown", { key: "Enter", bubbles: true });
			}
		},
	},
	{
		name: "assert message not primed to copy",
		match: /^the assistant message is not primed to copy$/,
		run: async ({ world }) => {
			// Read once: a retrying assertion would outwait the 3s reset to "Copy message".
			const labels = await lastAssistant(world.page)
				.locator(".assistant-header button[aria-label]")
				.evaluateAll((buttons) =>
					buttons.map((button) => button.getAttribute("aria-label")),
				);
			if (!labels.includes("Copy message")) {
				throw new Error(`The message is primed to copy: ${labels.join(", ")}`);
			}
		},
	},
	{
		name: "click the assistant message text",
		match: /^I click the assistant message text$/,
		run: async ({ world }) => {
			await lastAssistant(world.page).getByText("Here is the plan:").click();
		},
	},
	{
		name: "assert message primed to copy",
		match: /^the assistant message is primed to copy$/,
		run: async ({ world }) => {
			await expect(
				lastAssistant(world.page).getByRole("button", {
					name: "Click to confirm copy",
				}),
			).toHaveCount(1);
		},
	},
	{
		name: "reload the page",
		match: /^I reload the page$/,
		run: async ({ world }) => {
			await world.page.reload();
			await world.page.locator("#input").waitFor({ state: "visible" });
		},
	},
];
