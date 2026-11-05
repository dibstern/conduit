import { expect, type Page } from "@playwright/test";
import type {
	SessionDiffListing,
	SessionDiffPatch,
} from "../../../src/lib/contracts/session-diff.js";
import type { ToolFileChange } from "../../../src/lib/contracts/stored-event.js";
import type {
	HistoryMessagePartSchema,
	HistoryMessageSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { changed, patchFor } from "./sessionDiff.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

type Part = typeof HistoryMessagePartSchema.Type;
const SESSION = "sess-tool-diff";
const START = PINNED_CLOCK_MS - 60_000;
const FOLDER = "/workspace/myapp";

/** What each scope lists: tool listings by call id, and the turn's files. */
interface ToolDiffFixture {
	readonly tools: Map<
		string,
		{
			readonly listing: Omit<SessionDiffListing, "revision">;
			readonly notes?: SessionDiffPatch["notes"];
		}
	>;
	turn: readonly string[];
}
const fixtures = new WeakMap<Page, ToolDiffFixture>();

function fixtureFor(page: Page): ToolDiffFixture {
	const existing = fixtures.get(page);
	if (existing) return existing;
	const fixture: ToolDiffFixture = { tools: new Map(), turn: [] };
	fixtures.set(page, fixture);
	requireRpcControl(page).setStubs({
		SessionDiffList: ({ scope }) => {
			const listing =
				scope.kind === "toolCall"
					? fixture.tools.get(scope.toolId)?.listing
					: scope.kind === "turn"
						? {
								folders: [
									{
										folder: FOLDER,
										files: fixture.turn.map((path) => changed(path)),
									},
								],
							}
						: undefined;
			return { revision: JSON.stringify(scope), folders: [], ...listing };
		},
		SessionDiffFile: ({ scope, path }) => {
			const notes =
				scope.kind === "toolCall"
					? fixture.tools.get(scope.toolId)?.notes
					: undefined;
			return { patch: patchFor(path), ...(notes && { notes }) };
		},
	});
	return fixture;
}

const toolId = (name: string) => `call-tool-${name.toLowerCase()}`;

function tool(
	name: string,
	at: number,
	input: Record<string, unknown>,
	fileChanges?: readonly ToolFileChange[],
): Part {
	return {
		id: `part-tool-${name.toLowerCase()}`,
		type: "tool",
		tool: name,
		callID: toolId(name),
		time: { start: at, end: at + 2_000 },
		state: {
			status: "completed",
			input: { _tag: "whole", value: input },
			output: { _tag: "whole", text: `${name} finished.` },
			...(fileChanges && { fileChanges }),
		},
	};
}

/** A settled turn that edited, wrote and ran a shell command. */
function history(): (typeof HistoryMessageSchema.Type)[] {
	const edit = `${FOLDER}/src/app.ts`;
	const write = `${FOLDER}/notes.md`;
	return [
		{
			id: "tool-diff-user",
			role: "user",
			time: { created: START - 1_000 },
			parts: [
				{
					id: "tool-diff-prompt",
					type: "text",
					text: "Tidy the app and its notes.",
				},
			],
		},
		{
			id: "tool-diff-agent",
			role: "assistant",
			parentID: "tool-diff-user",
			time: { created: START, completed: PINNED_CLOCK_MS - 4_000 },
			parts: [
				tool(
					"Edit",
					START + 1_000,
					{ filePath: edit, oldString: "old", newString: "new" },
					[{ path: edit, kind: "update", before: "old\n", after: "new\n" }],
				),
				tool("Write", START + 4_000, { filePath: write, content: "notes\n" }, [
					{ path: write, kind: "add", after: "notes\n" },
				]),
				tool("Bash", START + 7_000, { command: "echo shell > shell.txt" }),
				{
					id: "tool-diff-final",
					type: "text",
					text: "The app and its notes are tidy.",
					time: {
						start: PINNED_CLOCK_MS - 6_000,
						end: PINNED_CLOCK_MS - 5_000,
					},
				},
			],
		},
	];
}

const step = (page: Page, name: string) =>
	page.locator(`#messages [data-tool-id="${toolId(name)}"]`);

const stepDiff = (page: Page) => page.getByTestId("tool-diff");

export const toolDiffHandlers: StepHandler[] = [
	{
		name: "seed a step's reported change",
		match:
			/^the (Edit|Write) step's change to (\S+) came from (the provider|the tool input)(?:, noting (replaced|unchecked))?$/,
		run: async ({ world, match }) => {
			const [, name = "", path = "", source, note] = match;
			fixtureFor(world.page).tools.set(toolId(name), {
				listing: {
					folders: [{ folder: FOLDER, files: [changed(path)] }],
					source: source === "the provider" ? "provider" : "toolInput",
				},
				...(note === "replaced" || note === "unchecked"
					? { notes: [note] }
					: {}),
			});
		},
	},
	{
		name: "seed the tool session's turn changes",
		match: /^the tool session's turn changed (\S+) and (\S+)$/,
		run: async ({ world, match }) => {
			fixtureFor(world.page).turn = [match[1] ?? "", match[2] ?? ""];
		},
	},
	{
		name: "seed the tool session",
		match: /^the tool session has a settled turn$/,
		run: async ({ world }) => {
			fixtureFor(world.page);
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				history().flatMap(detailRowsOf),
			);
			setSessionRowStatus(world.page, SESSION, "idle", {
				title: "Tool diffs",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, SESSION);
			await expect(
				world.page.locator("#messages .turn-activity").last(),
			).toBeVisible();
		},
	},
	{
		name: "open a log step",
		match: /^I open the (Edit|Write|Bash) step$/,
		run: async ({ world, match }) => {
			const button = step(world.page, match[1] ?? "")
				.getByRole("button")
				.first();
			await button.click();
			await expect(button).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "open a step's diff",
		match: /^I open the step's diff$/,
		run: async ({ world }) => {
			const toggle = world.page.getByTestId("tool-diff-toggle");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "step diff rows",
		match: /^the step diff lists (\S+)$/,
		run: async ({ world, match }) => {
			const rows = stepDiff(world.page).getByTestId("session-diff-file");
			await expect(rows).toHaveCount(1);
			await expect(rows).toHaveAttribute("data-path", match[1] ?? "");
		},
	},
	{
		name: "step diff source",
		match: /^the step diff says "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				stepDiff(world.page).getByTestId("tool-diff-source"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "shell step has no diff",
		match: /^the (Bash) step has no diff of its own$/,
		run: async ({ world, match }) => {
			const row = step(world.page, match[1] ?? "");
			await expect(row.getByTestId("tool-turn-diff")).toBeVisible();
			await expect(row.getByTestId("tool-diff-toggle")).toHaveCount(0);
			const requests = requireRpcControl(world.page).getRequests();
			expect(
				requests.filter(
					({ tag, payload }) =>
						tag === "SessionDiffList" &&
						(payload["scope"] as { kind?: string } | undefined)?.kind ===
							"toolCall",
				),
			).toEqual([]);
		},
	},
	{
		name: "open the turn diff from a step",
		match: /^I open the turn diff from the (Bash) step$/,
		run: async ({ world, match }) => {
			await step(world.page, match[1] ?? "")
				.getByTestId("tool-turn-diff")
				.click();
			await expect(
				world.page
					.locator("#messages .turn-activity")
					.last()
					.getByTestId("turn-diff-toggle"),
			).toHaveAttribute("aria-expanded", "true");
		},
	},
];
