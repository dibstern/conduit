import { expect } from "@playwright/test";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

export const sessionModeDefaultHandlers: StepHandler[] = [
	{
		name: "resolve the next draft's session mode",
		match:
			/^the next draft resolves to (local|worktree) from the project file$/,
		run: ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setStubs({
				ResolveSessionMode: () => ({
					mode: match[1] as "local" | "worktree",
					source: "file",
				}),
			});
			const projects = [
				{
					slug: "myapp",
					title: "myapp",
					folders: ["/myapp"] as const,
					git: { branch: "main" },
				},
			];
			rpc.setStubs({ GetProjects: () => ({ projects, current: "myapp" }) });
			rpc.setDaemonList("SubscribeProjects", { projects });
			rpc.setDaemonList("SubscribeInstances", {
				instances: [
					{
						id: "opencode",
						name: "OpenCode",
						driver: "opencode",
						isDefault: true,
						usageEligible: false,
						port: 0,
						managed: false,
						status: "healthy",
						restartCount: 0,
						createdAt: 0,
						capabilities: {
							supportsMultiFolder: true,
							supportsWorktree: false,
							supportsNewWorktree: true,
						},
					},
				],
			});
		},
	},
	{
		name: "open a draft in the default project",
		match: /^I open a new draft in the default project$/,
		run: async ({ world }) => {
			await world.page.goto(
				new URL("/new?project=myapp", world.page.url()).toString(),
			);
			await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "ResolveSessionMode" && payload["projectSlug"] === "myapp",
			);
		},
	},
	{
		name: "assert the draft's start mode",
		match: /^the draft start chip shows "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("draft-start-chip")).toHaveText(
				match[1] ?? "",
			);
		},
	},
];
