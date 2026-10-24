import { expect, type Page } from "@playwright/test";
import {
	PartVersion,
	ToolCallId,
	Utf8Bytes,
} from "../../../src/lib/contracts/tool-wire.js";
import type {
	HistoryMessage,
	HistoryMessagePart,
} from "../../../src/lib/shared-types.js";
import type { StepHandler } from "../runtime.js";
import { requireRelayControl, requireRpcControl } from "./shared.js";

const sessionId = "sess-first-send";
const messageId = "cursor-turn-assistant";
const parts = new WeakMap<Page, HistoryMessagePart[]>();
const fullCommandSuffix = "cursor-long-command-loaded";
const fullCommand = `printf '${"x".repeat(2200)}' # ${fullCommandSuffix}`;
const image =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const recording = "data:video/mp4;base64,AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29t";
// Date is pinned just after the snapshot times so elapsed timers render a short, stable duration.
const toolsClock = new Date("2026-10-02T00:00:05Z");
const row = (page: Page, id: string) =>
	page.locator(`.tool-item[data-tool-id="cursor-tools-${id}"]`);

function tool(
	id: string,
	name: string,
	input: Record<string, unknown>,
	output: string,
	metadata: Record<string, unknown> = {},
	status: "running" | "completed" | "error" = "completed",
): HistoryMessagePart {
	return {
		id: `cursor-tools-${id}`,
		callID: `cursor-tools-${id}`,
		type: "tool",
		tool: name,
		state: {
			status,
			input: { _tag: "whole", value: input },
			...(status !== "running" && {
				output: { _tag: "whole" as const, text: output },
			}),
			...(status === "error" && { error: output }),
			metadata: { cursorToolType: name, ...metadata },
		},
	};
}

// Publish the typed detail shape: the legacy tool mock drops metadata updates.
function publish(page: Page, added: HistoryMessagePart[]): void {
	const previous = parts.get(page) ?? [];
	const replaced = new Set(added.map(({ id }) => id));
	const next = [...previous.filter(({ id }) => !replaced.has(id)), ...added];
	parts.set(page, next);
	const messages: HistoryMessage[] = [
		{
			id: "cursor-tools-user",
			role: "user",
			// The send's inputId lets this placed prompt replace the browser's copy.
			inputId: String(
				requireRpcControl(page)
					.getRequests()
					.find(
						(request) =>
							request.tag === "input.submit" &&
							request.payload["text"] === "Render Cursor tools",
					)?.payload["inputId"],
			),
			time: { created: toolsClock.getTime() - 5_000 },
			parts: [
				{
					id: "cursor-tools-prompt",
					type: "text",
					text: "Render Cursor tools",
				},
			],
		},
		{
			id: messageId,
			role: "assistant",
			time: { created: toolsClock.getTime() - 4_000 },
			parts: next,
		},
	];
	requireRelayControl(page).sendMessage({
		type: "mock_transcript_snapshot",
		sessionId,
		history: { hasMore: false, messages },
	});
}

async function expand(page: Page, id: string): Promise<void> {
	await row(page, id).locator("button").first().click();
}

export const cursorToolsHandlers: StepHandler[] = [
	{
		name: "start Cursor shell with a long-command preview",
		match: /^the Cursor shell starts with a preview of a long command$/,
		run: ({ world }) => {
			const toolId = ToolCallId.make("cursor-tools-shell");
			requireRpcControl(world.page).setStubs({
				GetToolDetails: ({ toolIds }) => ({
					projectSlug: "myapp",
					tools: toolIds.includes(toolId)
						? [
								{
									toolId,
									version: PartVersion.make(1),
									settled: false,
									input: {
										_tag: "whole",
										value: { tool: "Bash", command: fullCommand },
									},
								},
							]
						: [],
				}),
			});
			parts.set(world.page, []);
			publish(world.page, [
				{
					id: toolId,
					callID: toolId,
					type: "tool",
					tool: "Bash",
					state: {
						status: "running",
						input: {
							_tag: "preview",
							value: { tool: "Bash", command: fullCommand.slice(0, 2000) },
							cuts: [
								{
									path: ["command"],
									fullBytes: Utf8Bytes.make(Buffer.byteLength(fullCommand)),
								},
							],
						},
						metadata: { cursorToolType: "shell" },
					},
				},
			]);
		},
	},
	{
		name: "assert full Cursor command loaded before shell output",
		match: /^the Cursor shell loads its full command before output arrives$/,
		run: async ({ world }) => {
			await requireRpcControl(world.page).waitForRequest(
				(request) => request.tag === "GetToolDetails",
			);
			await expect(
				row(world.page, "shell").locator(".shell-detail"),
			).toContainText(fullCommandSuffix);
		},
	},
	{
		name: "start Cursor shell tool",
		match: /^the Cursor shell starts with command (.+)$/,
		run: async ({ world, match }) => {
			await world.page.clock.setFixedTime(toolsClock);
			parts.set(world.page, []);
			publish(world.page, [
				tool(
					"shell",
					"Bash",
					{ tool: "Bash", command: match[1] },
					"",
					{},
					"running",
				),
			]);
		},
	},
	{
		name: "expand Cursor activity log",
		match: /^I expand the Cursor activity log$/,
		run: async ({ world }) => {
			const toggle = world.page.locator(".turn-activity-toggle");
			await expect(toggle).toHaveCount(1);
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "expand Cursor shell row",
		match: /^I expand the Cursor shell row$/,
		run: ({ world }) => expand(world.page, "shell"),
	},
	{
		name: "assert Cursor shell state",
		match:
			/^the Cursor shell row (keeps the base projected status|is an error|is completed)$/,
		run: async ({ world, match }) => {
			await expect(row(world.page, "shell")).toHaveAttribute(
				"data-tool-status",
				match[1] === "is an error" ? "error" : "completed",
			);
		},
	},
	{
		name: "stream Cursor shell output",
		match: /^the Cursor shell streams (stdout|stderr) (.+)$/,
		run: ({ world, match }) => {
			const current = parts
				.get(world.page)
				?.find(({ id }) => id === "cursor-tools-shell");
			if (!current?.state) throw new Error("The Cursor shell has not started");
			const metadata = current.state["metadata"] as Record<string, unknown>;
			const chunk = `${match[2]}\n`;
			const output = `${metadata["output"] ?? ""}${chunk}`;
			publish(world.page, [
				{
					...current,
					state: {
						...current.state,
						metadata: {
							...metadata,
							output,
						},
					},
				},
			]);
		},
	},
	{
		name: "assert Cursor shell output",
		match: /^the Cursor shell output contains (.+)$/,
		run: async ({ world, match }) => {
			await expect(
				row(world.page, "shell").locator(".shell-detail"),
			).toContainText(match[1] ?? "");
		},
	},
	{
		name: "finish Cursor shell tool",
		match: /^the Cursor shell finishes with exit code ([0-9]+)$/,
		run: ({ world, match }) => {
			const current = parts
				.get(world.page)
				?.find(({ id }) => id === "cursor-tools-shell");
			if (!current?.state) throw new Error("The Cursor shell has not started");
			const metadata = current.state["metadata"] as Record<string, unknown>;
			const output = String(metadata["output"] ?? "");
			const exitCode = Number(match[1]);
			publish(world.page, [
				{
					...current,
					state: {
						...current.state,
						status: exitCode === 0 ? "completed" : "error",
						...(exitCode !== 0 && { error: output }),
						output: { _tag: "whole", text: output },
						metadata: {
							cursorToolType: "shell",
							exitCode,
						},
					},
				},
			]);
		},
	},
	{
		name: "assert Cursor shell exit code",
		match: /^the Cursor shell exit code is ([0-9]+)$/,
		run: async ({ world, match }) => {
			await expect(
				row(world.page, "shell").getByTestId("tool-exit-code"),
			).toHaveText(new RegExp(`^[✓✗] exit ${match[1]}$`));
		},
	},
	{
		name: "publish Cursor file changes",
		match: /^the Cursor relay publishes file changes$/,
		run: ({ world }) =>
			publish(world.page, [
				tool(
					"edit",
					"Edit",
					{
						tool: "Edit",
						filePath: "src/value.ts",
						oldString: "old value",
						newString: "new value",
					},
					"Updated src/value.ts",
					{
						fileChange: {
							filePath: "src/value.ts",
							diff: "@@ -1 +1 @@\n-old value\n+new value\n",
							linesAdded: 1,
							linesRemoved: 1,
						},
					},
				),
				tool(
					"write",
					"Write",
					{
						tool: "Write",
						filePath: "src/new.ts",
						content: "first line\nsecond line\n",
					},
					"Created src/new.ts",
					{
						fileChange: {
							filePath: "src/new.ts",
							linesAdded: 2,
						},
					},
				),
				tool(
					"delete",
					"Delete",
					{ tool: "Unknown", name: "Delete", raw: { path: "src/deleted.ts" } },
					"Deleted src/deleted.ts",
					{
						fileChange: {
							filePath: "src/deleted.ts",
							fileSize: 23,
						},
					},
				),
			]),
	},
	{
		name: "assert Cursor file diff",
		match:
			/^the Cursor edit row shows old value replaced by new value with ([0-9]+) added and ([0-9]+) removed$/,
		run: async ({ world, match }) => {
			await expand(world.page, "edit");
			const diff = row(world.page, "edit").getByTestId("tool-file-change");
			await expect(diff).toBeVisible();
			await expect(diff.locator(".diff-stats span")).toHaveText([
				`+${match[1]}`,
				`-${match[2]}`,
			]);
			await expect(diff.locator("pre .text-error")).toHaveText("-old value\n");
			await expect(diff.locator("pre .text-success")).toHaveText(
				"+new value\n",
			);
		},
	},
	{
		name: "assert Cursor write SDK content and added count",
		match:
			/^the Cursor write row shows its content and ([0-9]+) added lines without a removed count$/,
		run: async ({ world, match }) => {
			await expand(world.page, "write");
			const change = row(world.page, "write").getByTestId("tool-file-change");
			await expect(change).toContainText("src/new.ts");
			await expect(change.locator(".diff-stats span")).toHaveText([
				`+${match[1]}`,
			]);
			await expect(change.locator("pre")).toHaveText(
				"first line\nsecond line\n",
			);
		},
	},
	{
		name: "assert Cursor delete SDK path and size",
		match:
			/^the Cursor delete row shows its path and ([0-9]+) bytes without invented lines$/,
		run: async ({ world, match }) => {
			await expand(world.page, "delete");
			const change = row(world.page, "delete").getByTestId("tool-file-change");
			await expect(change).toContainText("src/deleted.ts");
			await expect(change).toContainText(`${match[1]} bytes`);
			await expect(change.locator(".diff-stats span")).toHaveCount(0);
			await expect(change.locator("pre")).toHaveCount(0);
		},
	},
	{
		name: "publish Cursor exploration tools",
		match: /^the Cursor relay publishes exploration tools$/,
		run: ({ world }) =>
			publish(world.page, [
				tool(
					"read",
					"Read",
					{ tool: "Read", filePath: "src/value.ts" },
					"const value = 1;",
				),
				tool(
					"glob",
					"Glob",
					{ tool: "Glob", pattern: "src/*.ts" },
					"src/value.ts",
				),
				tool(
					"grep",
					"Grep",
					{ tool: "Grep", pattern: "value", path: "src" },
					"src/value.ts:1:const value = 1;",
				),
				tool(
					"ls",
					"Glob",
					{ tool: "Glob", pattern: "*", path: "src" },
					"src/value.ts",
				),
				tool(
					"readLints",
					"LSP",
					{ tool: "LSP", operation: "diagnostics", filePath: "src/value.ts" },
					"No diagnostics",
				),
				tool(
					"semSearch",
					"Grep",
					{ tool: "Grep", pattern: "where value is defined", path: "src" },
					"src/value.ts",
				),
			]),
	},
	{
		name: "assert compact Cursor exploration rows",
		match: /^all Cursor exploration tools have compact rows$/,
		run: async ({ world }) => {
			for (const id of [
				"read",
				"glob",
				"grep",
				"ls",
				"readLints",
				"semSearch",
			]) {
				await expect(row(world.page, id)).toBeVisible();
				await expect(row(world.page, id).locator(".tool-result")).toHaveCount(
					0,
				);
				await expect(
					row(world.page, id).locator("button").first(),
				).toContainText(
					id === "readLints"
						? "diagnostics"
						: id === "semSearch"
							? "where value is defined"
							: id === "ls"
								? "*"
								: id === "grep"
									? "value"
									: "src/",
				);
			}
		},
	},
	{
		name: "publish Cursor MCP todos and plan",
		match: /^the Cursor relay publishes MCP, todos and a plan$/,
		run: ({ world }) => {
			publish(world.page, [
				tool(
					"mcp",
					"mcp__docs__lookup",
					{
						tool: "Unknown",
						name: "mcp__docs__lookup",
						raw: { topic: "Cursor tools", server: "docs", toolName: "lookup" },
					},
					"Found Cursor documentation",
				),
				tool(
					"todos",
					"TodoWrite",
					{
						tool: "Unknown",
						name: "TodoWrite",
						raw: {
							todos: [
								{
									id: "review",
									content: "Review the patch",
									status: "in_progress",
								},
							],
						},
					},
					"Todos updated",
				),
				tool(
					"plan",
					"CreatePlan",
					{
						tool: "Unknown",
						name: "CreatePlan",
						raw: {
							plan: "# Cursor implementation plan\n\n- Inspect the patch\n- Run checks",
						},
					},
					"Plan created",
					{
						plan: {
							content:
								"# Cursor implementation plan\n\n- Inspect the patch\n- Run checks",
						},
					},
				),
			]);
			requireRpcControl(world.page).setSessionTodos(sessionId, [
				{
					id: "inspect",
					subject: "Inspect the tool trace",
					status: "completed",
				},
				{ id: "review", subject: "Review the patch", status: "in_progress" },
			]);
		},
	},
	{
		name: "assert Cursor MCP identity",
		match: /^the Cursor MCP row identifies docs and lookup$/,
		run: async ({ world }) => {
			await expect(row(world.page, "mcp")).toContainText("mcp__docs__lookup");
			await expand(world.page, "mcp");
			await expect(row(world.page, "mcp")).toContainText(
				"Found Cursor documentation",
			);
		},
	},
	{
		name: "assert Cursor todos panel",
		match: /^the Cursor todo panel contains (.+) and ([0-9]+\/[0-9]+)$/,
		run: async ({ world, match }) => {
			await expect(world.page.locator("#todo-sticky")).toContainText(
				match[1] ?? "",
			);
			await expect(
				world.page.locator("#todo-sticky .todo-header-count"),
			).toHaveText(match[2] ?? "");
		},
	},
	{
		name: "assert Cursor plan markdown",
		match: /^the Cursor plan renders the heading (.+)$/,
		run: async ({ world, match }) => {
			await expand(world.page, "plan");
			await expect(
				row(world.page, "plan")
					.getByTestId("tool-plan")
					.getByRole("heading", { name: match[1] ?? "" }),
			).toBeVisible();
		},
	},
	{
		name: "publish Cursor computer actions and media",
		match: /^the Cursor relay publishes computer actions and media$/,
		run: ({ world }) => {
			// Action fields follow ToolCall's public computerUse union in SDK 1.0.37.
			const actions = [
				{
					type: "click",
					coordinate: { x: 40, y: 50 },
					button: "left",
					count: 1,
				},
				{ type: "type", text: "Cursor tools" },
				{ type: "scroll", direction: "down", amount: 300 },
				{ type: "screenshot" },
			];
			publish(world.page, [
				tool(
					"computer",
					"ComputerUse",
					{ tool: "Unknown", name: "ComputerUse", raw: { actions } },
					"Computer actions completed",
					{
						computerUse: { actions },
						media: [
							{
								mime: "image/png",
								url: image,
								filename: "Computer screenshot",
							},
						],
					},
				),
				tool(
					"image",
					"generateImage",
					{
						tool: "Unknown",
						name: "generateImage",
						raw: { prompt: "A diagram of Cursor tools" },
					},
					"Image generated",
					{
						media: [
							{
								mime: "image/png",
								url: image,
								filename: "cursor-generated.png",
							},
						],
					},
				),
				tool(
					"recording",
					"recordScreen",
					{ tool: "Unknown", name: "recordScreen", raw: {} },
					"Screen recording completed",
					{
						media: [
							{
								mime: "video/mp4",
								url: recording,
								filename: "cursor-recording.mp4",
							},
						],
					},
				),
			]);
		},
	},
	{
		name: "assert Cursor computer actions",
		match: /^the Cursor computer row lists click, type, scroll and screenshot$/,
		run: async ({ world }) => {
			await expand(world.page, "computer");
			const actions = row(world.page, "computer").getByTestId(
				"tool-computer-actions",
			);
			await expect(actions.locator("li")).toHaveCount(4);
			for (const action of ["click", "type", "scroll", "screenshot"])
				await expect(actions).toContainText(action);
			await expect(actions).toContainText("Cursor tools");
		},
	},
	{
		name: "assert Cursor computer screenshot",
		match: /^the Cursor computer screenshot is attached$/,
		run: async ({ world }) => {
			await expect(
				row(world.page, "computer")
					.getByTestId("tool-media")
					.getByRole("img", { name: "Computer screenshot" }),
			).toHaveAttribute("src", image);
		},
	},
	{
		name: "assert generic Cursor media",
		match:
			/^the Cursor (generated image|recording) is attached to its generic row$/,
		run: async ({ world, match }) => {
			const id = match[1] === "recording" ? "recording" : "image";
			await expand(world.page, id);
			const media = row(world.page, id).getByTestId("tool-media");
			await expect(
				media.locator(id === "image" ? "img" : "video"),
			).toHaveAttribute("src", id === "image" ? image : recording);
		},
	},
	{
		name: "publish unknown and truncated Cursor tools",
		match: /^the Cursor relay publishes unknown and truncated tools$/,
		run: ({ world }) =>
			publish(world.page, [
				tool(
					"unknown",
					"futureCursorTool",
					{
						tool: "Unknown",
						name: "futureCursorTool",
						raw: { request: "keep the turn working" },
					},
					"Future tool completed",
				),
				tool(
					"truncated",
					"WebFetch",
					{
						tool: "WebFetch",
						url: "https://example.com",
						prompt: "Summarize the page",
					},
					"First page of tool output",
					{ truncated: true },
				),
			]),
	},
	{
		name: "assert unknown Cursor fallback",
		match: /^the unknown Cursor tool shows its arguments and result$/,
		run: async ({ world }) => {
			await expand(world.page, "unknown");
			await expect(row(world.page, "unknown")).toContainText(
				"futureCursorTool",
			);
			await row(world.page, "unknown").locator("summary").click();
			await expect(
				row(world.page, "unknown").locator("details pre"),
			).toBeVisible();
			await expect(
				row(world.page, "unknown").locator("details pre"),
			).toContainText("keep the turn working");
			await expect(row(world.page, "unknown")).toContainText(
				"Future tool completed",
			);
		},
	},
	{
		name: "assert truncated Cursor result",
		match: /^the truncated Cursor output is marked as truncated$/,
		run: async ({ world }) => {
			await expand(world.page, "truncated");
			await expect(
				row(world.page, "truncated").getByTestId("tool-truncated"),
			).toHaveText("Output truncated");
			await expect(row(world.page, "truncated")).toContainText(
				"First page of tool output",
			);
		},
	},
	{
		name: "publish Cursor task progress",
		match: /^the Cursor task reports progress (.+)$/,
		run: ({ world, match }) =>
			publish(world.page, [
				tool(
					"task",
					"cursor.task",
					{
						tool: "Unknown",
						name: "task",
						raw: { prompt: "Inspect the page" },
					},
					"",
					{ progress: match[1] },
					"running",
				),
			]),
	},
	{
		name: "assert running Cursor progress",
		match: /^the running Cursor turn shows progress (.+)$/,
		run: async ({ world, match }) => {
			// The composer has no status line; the running task row names its progress.
			await expect(row(world.page, "task")).toContainText(match[1] ?? "");
		},
	},
	{
		name: "assert generic Cursor task",
		match: /^the Cursor task remains a generic row$/,
		run: async ({ world }) => {
			await expect(row(world.page, "task")).toContainText("task");
			await expect(
				row(world.page, "task").getByRole("button", {
					name: "Open subagent session",
				}),
			).toHaveCount(0);
		},
	},
	{
		name: "assert completed Cursor read row",
		match: /^the Cursor read row is completed$/,
		run: async ({ world }) => {
			await expect(row(world.page, "read")).toHaveAttribute(
				"data-tool-status",
				"completed",
			);
		},
	},
	{
		name: "assert retained Cursor tool rows",
		match: /^every Cursor tool row remains available$/,
		run: async ({ world }) => {
			await expect(
				world.page.locator('.tool-item[data-tool-id^="cursor-tools-"]'),
			).toHaveCount(19);
		},
	},
];
