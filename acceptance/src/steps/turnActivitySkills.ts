import { expect } from "@playwright/test";
import type { HistoryMessageSchema } from "../../../src/lib/contracts/ws-rpc.js";
import { detailRowsOf } from "../../../test/helpers/detail-rows.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	openSessionRoute,
	requireRpcControl,
	setSessionRowStatus,
} from "./shared.js";

const SESSION = "sess-turn-skills";
const START = PINNED_CLOCK_MS - 20_000;

export const turnActivitySkillsHandlers: StepHandler[] = [
	{
		name: "seed a turn with two skill events",
		match: /^the turn log has two skills in a (settled|live) turn$/,
		run: async ({ world, match }) => {
			const live = match[1] === "live";
			const messages: (typeof HistoryMessageSchema.Type)[] = [
				{
					id: "skills-user",
					role: "user",
					time: { created: START },
					parts: [
						{
							id: "skills-prompt",
							type: "text",
							text: "Review the routing with two skills.",
						},
					],
				},
				{
					id: "skills-agent",
					role: "assistant",
					parentID: "skills-user",
					time: {
						created: START + 1_000,
						...(live ? {} : { completed: START + 16_000 }),
					},
					parts: [
						...[
							{
								id: "skill-first",
								tool: "Skill",
								input: { name: "brainstorming" },
								at: 1_000,
								took: 250,
							},
							{
								id: "read-first",
								tool: "Read",
								input: { filePath: "src/routes.ts" },
								at: 2_000,
								took: 3_000,
							},
							{
								id: "skill-second",
								tool: "Skill",
								input: { name: "tdd" },
								at: 7_000,
								took: 1_200,
							},
							{
								id: "read-second",
								tool: "Read",
								input: { filePath: "src/server.ts" },
								at: 9_000,
								took: 3_000,
							},
						].map(({ id, tool, input, at, took }) => ({
							id,
							type: "tool" as const,
							tool,
							callID: `call-${id}`,
							time: { start: START + at, end: START + at + took },
							state: {
								status: "completed" as const,
								input: { _tag: "whole" as const, value: input },
								output: { _tag: "whole" as const, text: "Done" },
							},
						})),
						...(live
							? []
							: [
									{
										id: "skills-final",
										type: "text" as const,
										text: "Routing reviewed.",
										time: { start: START + 14_000, end: START + 15_000 },
									},
								]),
					],
				},
			];
			requireRpcControl(world.page).setDetailRows(
				SESSION,
				messages.flatMap(detailRowsOf),
			);
			setSessionRowStatus(world.page, SESSION, live ? "busy" : "idle", {
				title: "Skill events",
				accountId: "claude",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, SESSION);
			await expect(world.page.locator("#messages")).toContainText(
				"Review the routing with two skills.",
			);
		},
	},
	{
		name: "assert chronological skill rows and their time column",
		match:
			/^the log shows both skills in order with sparkles, Skill, coloured names and times$/,
		run: async ({ world }) => {
			const log = world.page.locator(".step-log");
			await expect(log.locator(".tool-name")).toHaveText([
				"Skill",
				"Read",
				"Skill",
				"Read",
			]);
			for (const [name, time] of [
				["brainstorming", "250ms"],
				["tdd", "1s"],
			] as const) {
				const row = log.getByRole("button", {
					name: `Skill ${name}`,
					exact: true,
				});
				await expect(row).toBeVisible();
				await expect(row.locator(".lucide-sparkles")).toBeVisible();
				await expect(row.locator("time")).toHaveText(time);
				const paint = await row.locator(".tool-desc").evaluate((element) => {
					const style = getComputedStyle(element);
					const expected = document.createElement("span");
					expected.style.color = "var(--color-act-other)";
					element.append(expected);
					const colour = getComputedStyle(expected).color;
					expected.remove();
					return { actual: style.color, expected: colour };
				});
				expect(paint.actual).toBe(paint.expected);
				const timeBox = await row.locator("time").boundingBox();
				const normalTime = await log.locator("time").nth(1).boundingBox();
				if (!timeBox || !normalTime)
					throw new Error("Missing step time column");
				expect(
					Math.abs(timeBox.x + timeBox.width - normalTime.x - normalTime.width),
				).toBeLessThan(1);
			}
		},
	},
];
