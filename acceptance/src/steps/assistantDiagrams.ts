import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
	expect,
	type JSHandle,
	type Locator,
	type Page,
} from "@playwright/test";
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

const flowchart = "flowchart LR\n  Plan --> Build --> Ship";
// Wider than the desktop transcript, so pele shrinks it to fit.
const wide = `flowchart LR\n  ${["Plan the work", "Build the parts", "Test every path", "Review the change", "Merge to main", "Release the build", "Watch the metrics"].map((label, n) => `N${n}[${label}]`).join(" --> ")}`;
// Taller than the 380px cap.
const tallSteps = 10;
const tall = `flowchart TD\n  ${Array.from({ length: tallSteps }, (_, n) => `S${n}[Step ${n + 1}]`).join(" --> ")}`;
const fixtures = {
	"a flowchart diagram": [flowchart],
	"a broken flowchart diagram": ["flowchart LR\n  Plan -->|oops Build"],
	"an unknown diagram type": ["notadiagram\n  foo"],
	"a sequence diagram": ["sequenceDiagram\n  Alice->>Bob: Plan"],
	"a flowchart and two sequence diagrams": [
		flowchart,
		"sequenceDiagram\n  Alice->>Bob: Plan",
		"sequenceDiagram\n  Bob->>Alice: Ship",
	],
	"a wide and a small flowchart": [wide, flowchart],
	"a tall, a wide and a tall flowchart": [tall, wide, tall],
	"a wide flowchart": [wide],
	"a tall flowchart": [tall],
} as const;
type DiagramFixture = keyof typeof fixtures;
const fixturePattern = Object.keys(fixtures).join("|");

const STREAM_ID = "assistant-diagram-stream";
const seededSources = new WeakMap<Page, string>();
const scrolledFrom = new WeakMap<Page, number>();
const noted = new WeakMap<Page, { svg: JSHandle<Element>; fill: string }>();
const stalledDownloads = new WeakMap<Page, Promise<void>>();

const markdown = (sources: readonly string[]) =>
	`${["Here is the plan:", ...sources.map((source) => `\`\`\`mermaid\n${source}\n\`\`\``)].join("\n\n")}\n`;
const lastAssistant = (page: Page) =>
	page.locator("#messages .msg-assistant").last();
const diagram = (page: Page) => lastAssistant(page).locator("[data-diagram]");
// pele's root svg; header and zoom-control icons are svgs too.
const drawing = (page: Page) => diagram(page).locator("svg.pele").first();
const wideDrawing = (page: Page) =>
	diagram(page).filter({ hasText: "Watch the metrics" }).locator("svg.pele");
const viewer = (page: Page) => page.locator("dialog[open]");
const expandedDrawing = (page: Page) =>
	viewer(page).locator("[data-diagram] svg.pele");
const expandButton = (page: Page) =>
	diagram(page).getByRole("button", { name: "Expand diagram", exact: true });
// pele names each diagram type's chunk, and Vite keeps that name before the hash.
const sequenceChunk = () => {
	const chunk = /\["sequence",\(\)=>import\("\.\/chunks\/(\w+)\.js"\)/.exec(
		readFileSync(createRequire(import.meta.url).resolve("pele/lazy"), "utf8"),
	)?.[1];
	if (!chunk) throw new Error("pele's sequence chunk was not found");
	return new RegExp(`/assets/${chunk}-[\\w-]+\\.js$`);
};
const nodesInside = (svg: Element) => {
	const edge = svg.getBoundingClientRect();
	return [...svg.querySelectorAll(".pele-node")].filter((node) => {
		const b = node.getBoundingClientRect();
		return (
			b.top >= edge.top - 1 &&
			b.bottom <= edge.bottom + 1 &&
			b.left >= edge.left - 1 &&
			b.right <= edge.right + 1
		);
	}).length;
};
const transcriptScrollTop = (page: Page) =>
	page.locator("#messages").evaluate((element) => element.scrollTop);
const fitScales = new WeakMap<Page, number>();
// Screen pixels per diagram unit. Zooming in raises it, whatever size pele gives the svg meanwhile.
const scaleOf = (svg: Locator) =>
	svg.evaluate(
		(element: SVGSVGElement) =>
			element.getBoundingClientRect().width / element.viewBox.baseVal.width,
	);
const noteFit = async (svg: Locator) => {
	await expect(svg).toBeVisible();
	fitScales.set(svg.page(), await scaleOf(svg));
};
const zoomFromFit = async (svg: Locator) => {
	const fit = fitScales.get(svg.page());
	if (fit === undefined) throw new Error("No fit was noted");
	return (await scaleOf(svg)) / fit;
};
const expectZoomed = (svg: Locator) =>
	expect.poll(() => zoomFromFit(svg)).toBeGreaterThan(1.01);
const expectAtFit = (svg: Locator) =>
	expect
		.poll(async () => Math.abs((await zoomFromFit(svg)) - 1))
		.toBeLessThan(0.01);
const wheelOver = async (svg: Locator, deltaY: number) => {
	await noteFit(svg);
	await svg.hover();
	await svg.page().mouse.wheel(0, deltaY);
};
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
	await expect(drawing(page)).toBeVisible();
	const current = await drawing(page).elementHandle();
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
			const svg = drawing(world.page);
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
			const svg = await drawing(world.page).elementHandle();
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
			await world.page.route(sequenceChunk(), (route) => route.abort(), {
				times: 1,
			});
		},
	},
	{
		name: "stall the sequence renderer download",
		match: /^the sequence diagram renderer never finishes downloading$/,
		run: async ({ world }) => {
			let requested = (): void => {};
			stalledDownloads.set(
				world.page,
				new Promise((resolve) => (requested = resolve)),
			);
			// Never fulfilled: the diagram stays loading for the rest of the scenario.
			await world.page.route(sequenceChunk(), () => requested());
		},
	},
	{
		name: "assert loading diagram has no Expand button",
		match: /^the diagram is still loading and has no Expand button$/,
		run: async ({ world }) => {
			const page = world.page;
			const stalled = stalledDownloads.get(page);
			if (!stalled) throw new Error("No download was stalled");
			await stalled;
			await expect(diagram(page)).toBeVisible();
			await expect(drawing(page)).toHaveCount(0);
			await expect(expandButton(page)).toHaveCount(0);
		},
	},
	{
		name: "assert diagram has no Expand button",
		match: /^the diagram has no Expand button$/,
		run: ({ world }) => expect(expandButton(world.page)).toHaveCount(0),
	},
	{
		name: "assert the viewer shows the diagram centred and whole",
		match:
			/^the media viewer shows the diagram centred with zoom controls and all of it visible$/,
		run: async ({ world }) => {
			const page = world.page;
			const svg = expandedDrawing(page);
			await expect(svg).toBeVisible();
			await expect(viewer(page).locator(".pele-zoom-in")).toBeVisible();
			const box = await viewer(page).boundingBox();
			const size = page.viewportSize();
			const drawn = await svg.boundingBox();
			if (!box || !size || !drawn) throw new Error("The viewer has no box");
			expect(Math.abs(box.x + box.width / 2 - size.width / 2)).toBeLessThan(2);
			expect(Math.abs(box.y + box.height / 2 - size.height / 2)).toBeLessThan(
				2,
			);
			expect(drawn.y).toBeGreaterThanOrEqual(box.y);
			expect(drawn.y + drawn.height).toBeLessThanOrEqual(box.y + box.height);
			expect(await svg.evaluate(nodesInside)).toBe(tallSteps);
		},
	},
	{
		name: "assert the viewer fills the screen with a big close button",
		match:
			/^the media viewer fills the screen with a close button at least (\d+) pixels square$/,
		run: async ({ world, match }) => {
			const page = world.page;
			await expect(expandedDrawing(page)).toBeVisible();
			const box = await viewer(page).boundingBox();
			const size = page.viewportSize();
			const close = await viewer(page)
				.getByRole("button", { name: "Close media viewer", exact: true })
				.boundingBox();
			if (!box || !size || !close) throw new Error("The viewer has no box");
			expect(box).toEqual({
				x: 0,
				y: 0,
				width: size.width,
				height: size.height,
			});
			expect(close.width).toBeGreaterThanOrEqual(Number(match[1]));
			expect(close.height).toBeGreaterThanOrEqual(Number(match[1]));
		},
	},
	{
		name: "ctrl+wheel over the expanded diagram",
		match:
			/^I turn the mouse wheel up over the expanded diagram while holding Control$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.keyboard.down("Control");
			await wheelOver(expandedDrawing(page), -200);
			await page.keyboard.up("Control");
		},
	},
	{
		name: "assert the expanded diagram zoomed",
		match: /^the expanded diagram is zoomed$/,
		run: ({ world }) => expectZoomed(expandedDrawing(world.page)),
	},
	{
		name: "press Escape in the media viewer",
		match: /^I press Escape in the media viewer$/,
		run: ({ world }) => world.page.keyboard.press("Escape"),
	},
	{
		name: "assert the expanded diagram reset and viewer open",
		match:
			/^the expanded diagram is back to its fit and the media viewer is still open$/,
		run: async ({ world }) => {
			await expectAtFit(expandedDrawing(world.page));
			await expect(expandedDrawing(world.page)).toBeVisible();
		},
	},
	{
		name: "assert the media viewer accessible name",
		match: /^the media viewer is named (.+)$/,
		run: ({ world, match }) =>
			expect(world.page.getByRole("dialog")).toHaveAccessibleName(
				match[1] ?? "",
			),
	},
	{
		name: "assert Expand diagram has focus",
		match: /^the Expand diagram button has focus$/,
		run: ({ world }) => expect(expandButton(world.page)).toBeFocused(),
	},
	{
		name: "assert first diagram drawn, others failed to load",
		match:
			/^the first diagram is drawn and the other two say the renderer failed to load$/,
		run: async ({ world }) => {
			const diagrams = diagram(world.page);
			await expect(diagrams).toHaveCount(3);
			await expect(diagrams.nth(0).locator("svg.pele")).toBeVisible();
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
				await expect(diagrams.nth(n).locator("svg.pele")).toBeVisible();
			}
			await expect(lastAssistant(world.page)).not.toContainText(
				"failed to load",
			);
		},
	},
	{
		name: "assert zoom controls only on the shrunk diagram",
		match: /^the wide diagram shows zoom controls and the small one does not$/,
		run: async ({ world }) => {
			const page = world.page;
			const small = diagram(page).filter({ hasNotText: "Watch the metrics" });
			await expect(small.locator("svg.pele")).toBeVisible();
			await expect(
				diagram(page)
					.filter({ hasText: "Watch the metrics" })
					.locator(".pele-zoom-in"),
			).toBeVisible();
			await expect(small.locator(".pele-zoom-in")).toBeHidden();
		},
	},
	{
		name: "scroll the wide diagram to the middle",
		match: /^I scroll the wide diagram to the middle of the conversation$/,
		run: async ({ world }) => {
			await expect(wideDrawing(world.page)).toBeVisible();
			await wideDrawing(world.page).evaluate((svg) =>
				svg.scrollIntoView({ block: "center" }),
			);
		},
	},
	{
		name: "plain wheel over the wide diagram",
		match: /^I turn the mouse wheel down over the wide diagram$/,
		run: async ({ world }) => {
			scrolledFrom.set(world.page, await transcriptScrollTop(world.page));
			await wheelOver(wideDrawing(world.page), 200);
		},
	},
	{
		name: "assert the conversation scrolled, diagram not zoomed",
		match: /^the conversation scrolls and the wide diagram is not zoomed$/,
		run: async ({ world }) => {
			const from = scrolledFrom.get(world.page);
			if (from === undefined) throw new Error("No wheel was turned");
			await expect
				.poll(() => transcriptScrollTop(world.page))
				.toBeGreaterThan(from);
			await expectAtFit(wideDrawing(world.page));
		},
	},
	{
		name: "ctrl+wheel over the wide diagram",
		match:
			/^I turn the mouse wheel up over the wide diagram while holding Control$/,
		run: async ({ world }) => {
			await world.page.keyboard.down("Control");
			await wheelOver(wideDrawing(world.page), -200);
			await world.page.keyboard.up("Control");
		},
	},
	{
		name: "focus the wide diagram and press +",
		match: /^I focus the wide diagram and press \+$/,
		run: async ({ world }) => {
			await noteFit(wideDrawing(world.page));
			await wideDrawing(world.page).focus();
			await world.page.keyboard.press("+");
		},
	},
	{
		name: "assert the wide diagram zoomed",
		match: /^the wide diagram is zoomed$/,
		run: ({ world }) => expectZoomed(wideDrawing(world.page)),
	},
	{
		name: "assert capped, uncropped diagram",
		match: /^the diagram is at most (\d+) pixels tall and shows all of it$/,
		run: async ({ world, match }) => {
			const cap = Number(match[1]);
			const svg = drawing(world.page);
			await expect(svg).toBeVisible();
			if (Number(await svg.getAttribute("height")) <= cap)
				throw new Error("The fixture is not tall enough");
			const box = await svg.boundingBox();
			const frame = await diagram(world.page).boundingBox();
			if (!box || !frame) throw new Error("The diagram has no box");
			expect(box.height).toBeLessThanOrEqual(cap + 1);
			expect(box.x).toBeGreaterThanOrEqual(frame.x);
			expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
			// Every step is drawn inside the visible svg: nothing is cut off.
			expect(await svg.evaluate(nodesInside)).toBe(tallSteps);
		},
	},
	{
		name: "press a diagram header button",
		match:
			/^I press (Show code|Show diagram|Copy code|Expand diagram) on the diagram$/,
		run: async ({ world, match }) => {
			await world.page
				.context()
				.grantPermissions(["clipboard-read", "clipboard-write"]);
			await diagram(world.page)
				.getByRole("button", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "assert the diagram shows its source",
		match: /^the diagram shows its source instead of the drawing$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect(diagram(page).locator("pre code")).toHaveText(
				seededSources.get(page) ?? "",
			);
			await expect(drawing(page)).toBeHidden();
		},
	},
	{
		name: "assert clipboard holds the diagram source",
		match: /^the clipboard holds the diagram source$/,
		run: async ({ world }) => {
			const page = world.page;
			await expect
				.poll(() => page.evaluate(() => navigator.clipboard.readText()))
				// A fenced block's text ends with its closing newline.
				.toBe(`${seededSources.get(page)}\n`);
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
			const svg = drawing(world.page);
			await svg.click();
			await svg.click();
		},
	},
	{
		name: "press Enter on the drawn diagram twice",
		match: /^I press Enter on the drawn diagram twice$/,
		run: async ({ world }) => {
			// The inline diagram has nothing focusable yet, so send the key from inside it.
			const svg = drawing(world.page);
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
