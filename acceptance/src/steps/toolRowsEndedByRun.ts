import { expect, type Page } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl } from "./shared.js";

const created = PINNED_CLOCK_MS - 10 * 60_000;

/** One step per ending, shaped as the server sends them (82tn.45). */
const STEPS = [
	{ command: "List the files", status: "completed", outcome: "succeeded" },
	{ command: "Watch the build", status: "completed", outcome: "endedByRun" },
	{ command: "Run the tests", status: "error", outcome: "failed" },
] as const;

const rowOf = (page: Page, command: string) => {
	const index = STEPS.findIndex((step) => step.command === command);
	if (index < 0) throw new Error(`No step for ${command}`);
	return page.locator(
		`#messages .tool-item[data-tool-id="call-ended-${index}"]`,
	);
};

export const toolRowsEndedByRunHandlers: StepHandler[] = [
	{
		name: "seed a turn whose run ended one of its steps",
		match: /^the transcript has a turn whose run ended one of its steps$/,
		run: async ({ world }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Ended steps require an open session");
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId,
				history: {
					hasMore: false,
					messages: [
						{
							id: "msg-ended-user",
							role: "user",
							time: { created },
							parts: [
								{ id: "part-ended-user", type: "text", text: "Build it" },
							],
						},
						{
							id: "msg-ended-agent",
							role: "assistant",
							parentID: "msg-ended-user",
							time: { created: created + 1, completed: created + 60_000 },
							parts: [
								...STEPS.map(({ command, status, outcome }, index) => ({
									id: `part-ended-${index}`,
									type: "tool",
									tool: "Bash",
									callID: `call-ended-${index}`,
									state: {
										status,
										outcome,
										input: { tool: "Bash", command, description: command },
										...(outcome === "endedByRun"
											? {}
											: { output: outcome === "failed" ? "exit 1" : "ok" }),
									},
									time: {
										start: created + 1000 * (index + 1),
										end: created + 1000 * (index + 1) + 500,
									},
								})),
								{ id: "part-ended-reply", type: "text", text: "Done." },
							],
						},
					],
				},
			});
			await expect(
				world.page.locator("#messages .turn-activity-toggle").first(),
			).toBeVisible();
		},
	},
	{
		name: "assert how a step ended",
		match:
			/^the "(.+)" step (?:reads "(.+)"|shows no run ending) and is (not )?failed$/,
		run: async ({ world, match }) => {
			const row = rowOf(world.page, match[1] ?? "");
			await expect(row).toBeVisible();
			const ending = row.locator(".tool-ended-by-run");
			if (match[2] === undefined) await expect(ending).toHaveCount(0);
			else await expect(ending).toHaveText(match[2]);
			if (match[3])
				await expect(row).not.toHaveAttribute("data-tool-outcome", "failed");
			else await expect(row).toHaveAttribute("data-tool-outcome", "failed");
		},
	},
];
