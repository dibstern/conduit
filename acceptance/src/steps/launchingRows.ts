import { expect, type Page } from "@playwright/test";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const sessionIdOf = (page: Page): string => {
	const sessionId = new URL(page.url()).pathname.split("/")[2];
	if (!sessionId) throw new Error("Launching rows require an open session");
	return sessionId;
};

const created = PINNED_CLOCK_MS - 10 * 60_000;

/** One launching tool call per row state, named and shaped as the Claude
 *  provider persists them (an Agent call is stored as canonical Task). */
const LAUNCHES = [
	{
		description: "Map the session store",
		tool: "Task",
		metadata: { providerTaskId: "task-fg", taskStartedAt: created + 1000 },
	},
	{
		description: "Run the dev server",
		tool: "Bash",
		metadata: {
			providerTaskId: "task-shell",
			backgrounded: true,
			taskStartedAt: PINNED_CLOCK_MS - 95_000,
		},
	},
	{
		description: "Fix the flaky test",
		tool: "Task",
		metadata: {
			providerTaskId: "task-agent",
			backgrounded: true,
			taskStartedAt: PINNED_CLOCK_MS - 42_000,
			currentStep: "Running pnpm test",
			totalTokens: 12_400,
			toolUses: 3,
		},
	},
	{
		description: "Review the router",
		tool: "Task",
		metadata: {
			providerTaskId: "task-review",
			backgrounded: true,
			outcome: "completed",
			taskDurationMs: 18_177,
			totalTokens: 23_551,
			toolUses: 6,
		},
	},
	{
		description: "Run the e2e suite",
		tool: "Bash",
		metadata: {
			providerTaskId: "task-e2e",
			backgrounded: true,
			outcome: "failed",
			taskStartedAt: created + 2000,
			endTime: created + 2000 + 252_000,
		},
	},
	{
		description: "Profile the build",
		tool: "Task",
		metadata: {
			providerTaskId: "task-profile",
			backgrounded: true,
			outcome: "stopped",
			taskDurationMs: 61_000,
			totalTokens: 8_200,
			toolUses: 2,
		},
	},
	{
		description: "Watch the logs",
		tool: "Bash",
		metadata: {
			providerTaskId: "task-logs",
			backgrounded: true,
			taskStartedAt: created + 3000,
		},
	},
] as const;

const callIdOf = (description: string): string => {
	const index = LAUNCHES.findIndex((row) => row.description === description);
	if (index < 0) throw new Error(`No launching row for ${description}`);
	return `call-launch-${index}`;
};

const rowOf = (page: Page, description: string) =>
	page.locator(`#messages .tool-item[data-tool-id="${callIdOf(description)}"]`);

const STATES: Record<string, string> = {
	running: "running",
	done: "completed",
	failed: "failed",
	stopped: "stopped",
	"no longer running": "gone",
};

const breathing = (page: Page) =>
	page
		.locator("#messages .turn-activity")
		.first()
		.locator('[aria-label^="Activity timeline"] button.animate-pulse');

export const launchingRowsHandlers: StepHandler[] = [
	{
		name: "seed the root session's live background tasks",
		match:
			/^the session's live background tasks are the dev server, the flaky-test agent and that agent's nested shell$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const id = sessionIdOf(world.page);
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === id,
			);
			rpc.setShellRows([
				{
					...(row as object | undefined),
					id,
					status: "idle",
					updatedAt: PINNED_CLOCK_MS,
					backgroundWork: "working",
					backgroundTasks: [
						{
							id: "task-shell",
							type: "local_bash",
							description: "Run the dev server",
							firstSeenAt: PINNED_CLOCK_MS - 95_000,
						},
						{
							id: "task-agent",
							type: "local_agent",
							description: "Fix the flaky test",
							firstSeenAt: PINNED_CLOCK_MS - 42_000,
							childSessionId: "sess-flaky-test",
						},
						{
							id: "task-nested",
							type: "local_bash",
							description: "pnpm test --watch",
							firstSeenAt: PINNED_CLOCK_MS - 20_000,
							parentTaskId: "task-agent",
						},
					],
				},
			]);
		},
	},
	{
		name: "end every live background task",
		match: /^the session's live background tasks all finish$/,
		run: ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const id = sessionIdOf(world.page);
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === id,
			);
			// undefined drops out of the JSON snapshot, clearing the tasks.
			rpc.setShellRows([
				{
					...(row as object | undefined),
					id,
					backgroundWork: undefined,
					backgroundTasks: undefined,
				},
			]);
		},
	},
	{
		name: "advance the launching row clock",
		match: /^the launching row clock advances by ([0-9]+) seconds$/,
		run: async ({ world, match }) => {
			await world.page.clock.setFixedTime(
				new Date(PINNED_CLOCK_MS + Number(match[1]) * 1000),
			);
		},
	},
	{
		name: "assert the turn head's running pill",
		match: /^the turn head shows (?:"([0-9]+) running"|no running pill)$/,
		run: async ({ world, match }) => {
			const pill = world.page.locator("#messages .turn-running");
			if (match[1] === undefined) await expect(pill).toHaveCount(0);
			else
				await expect(pill).toHaveText(
					new RegExp(`^\\s*${match[1]}\\s+running\\s*$`),
				);
		},
	},
	{
		name: "assert breathing launching steps",
		match: /^(no|[0-9]+) launching steps breathe on the activity strip$/,
		run: async ({ world, match }) => {
			await expect(breathing(world.page)).toHaveCount(
				match[1] === "no" ? 0 : Number(match[1]),
			);
		},
	},
	{
		name: "seed a turn that launched a task in every state",
		match: /^the transcript has a turn that launched a task in every state$/,
		run: async ({ world }) => {
			requireRelayControl(world.page).sendMessage({
				type: "mock_transcript_snapshot",
				sessionId: sessionIdOf(world.page),
				history: {
					hasMore: false,
					messages: [
						{
							id: "msg-launch-user",
							role: "user",
							time: { created },
							parts: [
								{
									id: "part-launch-user",
									type: "text",
									text: "Fix the flaky test and keep the dev server up",
								},
							],
						},
						{
							id: "msg-launch-agent",
							role: "assistant",
							parentID: "msg-launch-user",
							time: { created: created + 1, completed: created + 60_000 },
							parts: [
								...LAUNCHES.map(({ description, tool, metadata }, index) => ({
									id: `part-launch-${index}`,
									type: "tool",
									tool,
									callID: `call-launch-${index}`,
									state: {
										status: "completed",
										input:
											tool === "Bash"
												? { tool, command: description, description }
												: {
														tool,
														description,
														prompt: description,
														subagentType: "general-purpose",
													},
										output: "Started in the background.",
										metadata,
									},
									time: {
										start: created + 1000 * (index + 1),
										end: created + 1000 * (index + 1) + 500,
									},
								})),
								{
									id: "part-launch-reply",
									type: "text",
									text: "The dev server and the flaky-test agent are running in the background.",
								},
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
		name: "open the turn's steps",
		match: /^I open the turn's steps$/,
		run: async ({ world }) => {
			const toggle = world.page
				.locator("#messages .turn-activity-toggle")
				.first();
			if ((await toggle.getAttribute("aria-expanded")) === "false")
				await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "assert a foreground task stays an ordinary step",
		match: /^the "(.+)" step is an ordinary foreground step$/,
		run: async ({ world, match }) => {
			const row = rowOf(world.page, match[1] ?? "");
			await expect(row).toBeVisible();
			await expect(row).not.toHaveAttribute("data-launch-state");
			await expect(row.locator(".launch-meta")).toHaveCount(0);
		},
	},
	{
		name: "assert a launching row's state and meta",
		match:
			/^the "(.+)" launching row is (running|done|failed|stopped|no longer running) and reads "(.+)"$/,
		run: async ({ world, match }) => {
			const row = rowOf(world.page, match[1] ?? "");
			await expect(row).toHaveAttribute(
				"data-launch-state",
				STATES[match[2] ?? ""] ?? "",
			);
			await expect(row.locator(".launch-meta")).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "assert a launching row's current step and nested count",
		match: /^the "(.+)" launching row is doing "(.+)" with (\+[0-9]+ tasks?)$/,
		run: async ({ world, match }) => {
			const row = rowOf(world.page, match[1] ?? "");
			await expect(row.locator(".launch-step")).toHaveText(`· ${match[2]}`);
			await expect(row.locator(".launch-nested")).toHaveText(match[3] ?? "");
		},
	},
	{
		name: "assert a launching row has no step or nested count",
		match: /^the "(.+)" launching row shows no step and no nested tasks$/,
		run: async ({ world, match }) => {
			const row = rowOf(world.page, match[1] ?? "");
			await expect(row.locator(".launch-step")).toHaveCount(0);
			await expect(row.locator(".launch-nested")).toHaveCount(0);
		},
	},
	{
		name: "assert a launching row's accessible label",
		match: /^the "(.+)" launching row announces "(.+)"$/,
		run: async ({ world, match }) => {
			const button = rowOf(world.page, match[1] ?? "")
				.locator("button")
				.first();
			await expect(button).toHaveAttribute(
				"aria-label",
				new RegExp(
					`, ${(match[2] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
				),
			);
		},
	},
];
