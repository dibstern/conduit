import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, type JSHandle, type Page } from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

const flowchart = "flowchart LR\n  Plan --> Build --> Ship";
const fixtures = {
	"a flowchart diagram": [flowchart],
	"a broken flowchart diagram": ["flowchart LR\n  Plan -->|oops Build"],
	"an unknown diagram type": ["notadiagram\n  foo"],
	"a flowchart and two sequence diagrams": [
		flowchart,
		"sequenceDiagram\n  Alice->>Bob: Plan",
		"sequenceDiagram\n  Bob->>Alice: Ship",
	],
} as const;
type DiagramFixture = keyof typeof fixtures;
const fixturePattern = Object.keys(fixtures).join("|");

const STREAM_ID = "assistant-diagram-stream";
const seededSources = new WeakMap<Page, string>();
const noted = new WeakMap<Page, { svg: JSHandle<Element>; fill: string }>();

const markdown = (sources: readonly string[]) =>
	`${["Here is the plan:", ...sources.map((source) => `\`\`\`mermaid\n${source}\n\`\`\``)].join("\n\n")}\n`;
const lastAssistant = (page: Page) =>
	page.locator("#messages .msg-assistant").last();
const diagram = (page: Page) => lastAssistant(page).locator("[data-diagram]");
const nodeFill = (svg: Element) => {
	const shape = svg.querySelector(".pele-node rect");
	return shape ? getComputedStyle(shape).fill : "";
};
const notedDiagram = (page: Page) => {
	const before = noted.get(page);
	if (!before) throw new Error("No diagram was noted");
	return before;
};
const assertNotedStillShown = async (page: Page) => {
	const current = await diagram(page).locator("svg").first().elementHandle();
	const same = await notedDiagram(page).svg.evaluate(
		(svg, other) => svg.isConnected && svg === other,
		current,
	);
	if (!same) throw new Error("The noted diagram was redrawn");
};

export const assistantDiagramsHandlers: StepHandler[] = [
	{
		name: "seed a finished assistant message with a diagram",
		match: new RegExp(
			`^the transcript contains a finished assistant message with (${fixturePattern})$`,
		),
		run: async ({ world, match }) => {
			const page = world.page;
			const sources = fixtures[match[1] as DiagramFixture];
			seededSources.set(page, sources[0]);
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
							text: markdown(sources),
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
			seededSources.set(world.page, flowchart);
			requireRelayControl(world.page).sendMessage({
				type: "delta",
				text: markdown([flowchart]),
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
			const before = notedDiagram(world.page);
			await expect
				.poll(() => before.svg.evaluate(nodeFill))
				.not.toBe(before.fill);
			await assertNotedStillShown(world.page);
		},
	},
	{
		name: "assert noted diagram still on screen",
		match: /^the noted diagram is still on screen$/,
		run: ({ world }) => assertNotedStillShown(world.page),
	},
	{
		name: "fail the sequence renderer download once",
		match: /^the sequence diagram renderer fails to download once$/,
		run: async ({ world }) => {
			// pele names each diagram type's chunk, and Vite keeps that name before the hash.
			const chunk = /\["sequence",\(\)=>import\("\.\/chunks\/(\w+)\.js"\)/.exec(
				readFileSync(
					createRequire(import.meta.url).resolve("pele/lazy"),
					"utf8",
				),
			)?.[1];
			if (!chunk) throw new Error("pele's sequence chunk was not found");
			await world.page.route(
				new RegExp(`/assets/${chunk}-[\\w-]+\\.js$`),
				(route) => route.abort(),
				{ times: 1 },
			);
		},
	},
	{
		name: "assert first diagram drawn, others failed to load",
		match:
			/^the first diagram is drawn and the other two say the renderer failed to load$/,
		run: async ({ world }) => {
			const diagrams = diagram(world.page);
			await expect(diagrams).toHaveCount(3);
			await expect(diagrams.nth(0).locator("svg").first()).toBeVisible();
			for (const n of [1, 2]) {
				await expect(diagrams.nth(n)).toContainText(
					"The diagram renderer failed to load",
				);
			}
		},
	},
	{
		name: "press Retry on one failed diagram",
		match: /^I press Retry on one failed diagram$/,
		run: async ({ world }) => {
			await diagram(world.page)
				.nth(1)
				.getByRole("button", { name: "Retry", exact: true })
				.click();
		},
	},
	{
		name: "assert every diagram drawn",
		match: /^every diagram in the assistant message is drawn$/,
		run: async ({ world }) => {
			const diagrams = diagram(world.page);
			for (const n of [0, 1, 2]) {
				await expect(diagrams.nth(n).locator("svg").first()).toBeVisible();
			}
			await expect(lastAssistant(world.page)).not.toContainText(
				"failed to load",
			);
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
