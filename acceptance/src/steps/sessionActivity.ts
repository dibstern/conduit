import type { Page } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { setSessionRowStatus } from "./shared.js";

const openSession = (page: Page): string => {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("No session is open");
	return sessionId;
};

export const sessionActivityHandlers: StepHandler[] = [
	{
		// 4ejl7 and 3wxx: the server reads a wake Run as working while the stored status reads idle.
		name: "wake turn with an idle stored status",
		match: /^Claude's wake turn runs while the stored status reads idle$/,
		run: async ({ world }) => {
			const sessionId = openSession(world.page);
			setSessionRowStatus(world.page, sessionId, "idle", {
				activity: {
					foreground: "working",
					background: "none",
					label: "working",
				},
				processing: true,
				attention: "working",
				wakeRun: { task: "sleep 8" },
			});
		},
	},
	{
		name: "background tasks with a busy stored status",
		match: /^only background tasks run while the stored status reads busy$/,
		run: async ({ world }) => {
			const sessionId = openSession(world.page);
			setSessionRowStatus(world.page, sessionId, "busy", {
				activity: { foreground: "idle", background: "work", label: "working" },
				processing: true,
				attention: "working",
			});
		},
	},
	{
		name: "assert stop button visibility",
		match: /^the stop button is (visible|not visible)$/,
		run: async ({ world, match }) => {
			await world.page.locator("#stop").waitFor({
				state: match[1] === "visible" ? "visible" : "hidden",
			});
		},
	},
];
