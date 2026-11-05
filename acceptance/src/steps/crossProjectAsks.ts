import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl, setSessionRowStatus } from "./shared.js";

/** The project tree fixture names its sessions `<slug>-<n>`. */
const ownerOf = (sessionId: string) => sessionId.split("-")[0] ?? null;

export const crossProjectAsksHandlers: StepHandler[] = [
	{
		name: "attach the opened session's own project",
		match: /^opening a session attaches the session's own project$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setStubs({
				AttachProject: (payload) => {
					const projectSlug =
						"sessionId" in payload
							? ownerOf(payload.sessionId)
							: (payload.projectSlug ?? rpc.projectSlug);
					return {
						projectSlug,
						sessionSlug: "sessionId" in payload ? projectSlug : null,
					};
				},
			});
		},
	},
	{
		name: "a Beacon session starts waiting on you",
		match: /^Beacon session (\d+) starts waiting on (approval|a reply)$/,
		run: ({ world, match }) => {
			const approval = match[2] === "approval";
			setSessionRowStatus(world.page, `beacon-${match[1]}`, "idle", {
				title: `Beacon session ${match[1]}`,
				projectSlug: "beacon",
				attention: approval ? "needs-approval" : "needs-reply",
				...(approval
					? { pendingPermissionCount: 1 }
					: { pendingQuestionCount: 1 }),
			});
		},
	},
	{
		name: "assert the Beacon session is open in its own project",
		match: /^Beacon session (\d+) is open, attached to the (\w+) project$/,
		run: async ({ world, match }) => {
			const sessionId = `beacon-${match[1]}`;
			await expect(world.page).toHaveURL(
				new RegExp(`/s/${sessionId}(?:[/?]|$)`),
			);
			await expect
				.poll(() =>
					requireRpcControl(world.page)
						.getRequests()
						.some(
							(request) =>
								request.tag === "AttachProject" &&
								ownerOf(sessionId) === match[2] &&
								// A known row attaches its project; an unknown one asks by id.
								(request.payload["projectSlug"] === match[2] ||
									request.payload["sessionId"] === sessionId),
						),
				)
				.toBe(true);
			await expect(world.page.getByTestId("toast")).toHaveCount(0);
		},
	},
];
