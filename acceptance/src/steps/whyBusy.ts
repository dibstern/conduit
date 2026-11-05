import { expect, type Page } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, setSessionRowStatus } from "./shared.js";

const openSession = (page: Page): string => {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("No session is open");
	return sessionId;
};

const view = (page: Page) => page.getByTestId("why-busy");
const trigger = (page: Page) => page.getByTestId("why-busy-trigger");

/** What the server sends a row for each state (82tn.56): the indicator tier and Session Activity. */
const STATES: Record<string, Record<string, unknown>> = {
	"answers a message beside background work": {
		attention: "working",
		processing: true,
		activity: { foreground: "working", background: "work", label: "working" },
		backgroundWork: "working",
	},
	"failed beside background work": {
		attention: "error",
		processing: true,
		activity: { foreground: "idle", background: "work", label: "working" },
		backgroundWork: "working",
	},
};

export const whyBusyHandlers: StepHandler[] = [
	{
		name: "seed a turn with one open step and one the run ended",
		match:
			/^the transcript has a turn with one open step and one step the run ended$/,
		run: async ({ world }) => {
			const sessionId = openSession(world.page);
			const start = PINNED_CLOCK_MS - 60_000;
			// Shaped as toolRowsEndedByRun.ts seeds a turn; one step is still open.
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: {
					hasMore: false,
					messages: [
						{
							id: "msg-busy-user",
							role: "user",
							time: { created: start },
							parts: [{ id: "part-busy-user", type: "text", text: "Build it" }],
						},
						{
							id: "msg-busy-agent",
							role: "assistant",
							parentID: "msg-busy-user",
							time: { created: start + 1, completed: start + 30_000 },
							parts: [
								{
									id: "part-busy-ended",
									type: "tool",
									tool: "Bash",
									callID: "call-busy-ended",
									state: {
										status: "completed",
										outcome: "endedByRun",
										input: {
											tool: "Bash",
											command: "Watch the build",
											description: "Watch the build",
										},
									},
									time: { start: start + 1000, end: start + 1500 },
								},
								{
									id: "part-busy-open",
									type: "tool",
									tool: "Bash",
									callID: "call-busy-open",
									state: {
										status: "running",
										input: {
											tool: "Bash",
											command: "pnpm build",
											description: "pnpm build",
										},
									},
									time: { start: start + 2000 },
								},
							],
						},
					],
				},
			});
			await expect(world.page.locator("#messages")).toContainText("Build it");
		},
	},
	{
		name: "the session's row reads a state",
		match:
			/^the session (answers a message beside background work|failed beside background work) (.+)$/,
		run: async ({ world, match }) => {
			const sessionId = openSession(world.page);
			setSessionRowStatus(world.page, sessionId, "busy", {
				...STATES[match[1] ?? ""],
				backgroundTasks: [
					{
						id: "task-busy",
						type: "local_bash",
						kind: "shell",
						description: match[2] ?? "",
						firstSeenAt: PINNED_CLOCK_MS - 120_000,
					},
				],
			});
		},
	},
	{
		name: "open why the session is busy",
		match: /^I open why the session is busy$/,
		run: async ({ world }) => {
			const page = world.page;
			// A phone's collapsed bar shows the title only; its chips come with the expanded bar.
			if (
				(await page.locator("#session-bar").getAttribute("data-collapsed")) ===
				"true"
			)
				await page.getByTestId("session-bar-expand").click();
			await trigger(page).click();
			await expect(view(page)).toBeVisible();
		},
	},
	{
		name: "why-busy reasons in order",
		match: /^why the session is busy reads "(.+)" then "(.+)"$/,
		run: async ({ world, match }) => {
			await expect(
				view(world.page)
					.getByTestId("why-busy-reason")
					.locator("> div:first-child"),
			).toHaveText([match[1] ?? "", match[2] ?? ""]);
		},
	},
	{
		name: "why-busy detail line",
		match: /^why the session is busy shows "(.+)"$/,
		run: async ({ world, match }) => {
			await expect(view(world.page)).toContainText(match[1] ?? "");
		},
	},
	{
		name: "why-busy open tool calls",
		match: /^why the session is busy lists the open tool call "(.+)" only$/,
		run: async ({ world, match }) => {
			await expect(view(world.page).getByTestId("why-busy-tool")).toHaveCount(
				1,
			);
			await expect(view(world.page).getByTestId("why-busy-tool")).toContainText(
				match[1] ?? "",
			);
		},
	},
	{
		name: "why-busy trigger shown or not",
		match: /^the session bar offers (a|no) why-busy view$/,
		run: async ({ world, match }) => {
			const page = world.page;
			if (
				(await page.locator("#session-bar").getAttribute("data-collapsed")) ===
				"true"
			)
				await page.getByTestId("session-bar-expand").click();
			await expect(trigger(page)).toHaveCount(match[1] === "a" ? 1 : 0);
		},
	},
];
