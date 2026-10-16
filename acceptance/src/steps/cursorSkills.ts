import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

export const cursorSkillsHandlers: StepHandler[] = [
	{
		name: "seed Cursor skills catalog",
		match: /^the Cursor account has skills (\S+) and (\S+)$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const { GetCommands: getCommands } = rpc.stubs;
			if (!getCommands)
				throw new Error("Cursor skills wrap the mockup's command stub");
			const commands = [match[1] ?? "", match[2] ?? ""].map((name) => ({
				name,
				description: `Cursor skill ${name}`,
			}));
			rpc.setStubs({
				GetCommands: (payload) =>
					payload.instanceId === "cursor-work" ||
					("sessionId" in payload && payload.sessionId === "sess-first-send")
						? { projectSlug: "myapp", commands }
						: getCommands(payload),
			});
		},
	},
	{
		name: "assert Cursor skills command list",
		match: /^the Cursor command menu lists exactly (.+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#command-menu .cmd-name")).toHaveText(
				(match[1] ?? "").split(", "),
			);
		},
	},
	{
		name: "select Cursor skill command",
		match: /^I pick the Cursor skill (\S+)$/,
		run: async ({ world, match }) => {
			await world.page
				.locator("#command-menu")
				.getByText(`/${match[1]}`, { exact: true })
				.click();
		},
	},
	{
		name: "assert Cursor skill invocation",
		match: /^the composer contains the Cursor invocation (\/\S+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#input")).toHaveValue(`${match[1]} `);
		},
	},
	{
		name: "append Cursor skill arguments",
		match: /^I append (.+) to the Cursor invocation$/,
		run: async ({ world, match }) => {
			await world.page.locator("#input").press("End");
			await world.page.locator("#input").pressSequentially(match[1] ?? "");
		},
	},
];
