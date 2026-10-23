import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";

const openTask = vi.hoisted(() => vi.fn());
const openSession = vi.hoisted(() => vi.fn());
vi.mock(
	"../../../src/lib/frontend/components/session/background-tasks.svelte.js",
	() => ({ openTask }),
);
vi.mock("../../../src/lib/frontend/stores/selection.svelte.js", () => ({
	selection: { open: openSession },
}));

import ActivityRow from "../../../src/lib/frontend/components/chat/ActivityRow.svelte";
import ToolGenericCard from "../../../src/lib/frontend/components/chat/ToolGenericCard.svelte";

const agent: ToolMessage = {
	type: "tool",
	uuid: "message/part",
	id: "part",
	name: "Task",
	status: "completed",
	input: {
		tool: "Task",
		description: "Review the router",
		prompt: "Review it",
		subagent_type: "general-purpose",
	},
	result: "Launch result",
	metadata: {
		providerTaskId: "agent",
		backgrounded: true,
		childSessionId: "child",
	},
};
const props = {
	part: agent,
	liveTasks: [],
	taskListedAt: new Map<string, number>(),
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ActivityRow task actions", () => {
	it.each([
		{ outcome: "failed", status: "completed", isError: false, failed: true },
		{ outcome: "succeeded", status: "error", isError: true, failed: false },
	] as const)("uses $outcome for its failure presentation", ({
		outcome,
		status,
		isError,
		failed,
	}) => {
		const { container } = render(ActivityRow, {
			props: {
				...props,
				part: {
					...agent,
					name: "Bash",
					outcome,
					status,
					isError,
					metadata: {},
				},
			},
		});
		expect(container.querySelector(".text-error") !== null).toBe(failed);
	});

	it("opens a background agent from the primary row instead of expanding its launch result", async () => {
		const { container } = render(ActivityRow, { props });
		await fireEvent.click(
			container.querySelector("button") as HTMLButtonElement,
		);
		expect(openTask).toHaveBeenCalledWith(
			{ id: "agent", sessionId: "child", description: "Review the router" },
			{ messageId: "message", partId: "part" },
		);
		expect(container.querySelector(".tool-result")).toBeNull();
	});

	it("keeps a background shell inert with no drill-in arrow", async () => {
		const { container } = render(ActivityRow, {
			props: {
				...props,
				part: {
					...agent,
					name: "Bash",
					input: { tool: "Bash", command: "pnpm dev" },
					metadata: { providerTaskId: "shell", backgrounded: true },
				},
			},
		});
		expect(
			(container.querySelector("button") as HTMLButtonElement).disabled,
		).toBe(true);
		await fireEvent.click(
			container.querySelector("button") as HTMLButtonElement,
		);
		expect(openTask).not.toHaveBeenCalled();
		expect(openSession).not.toHaveBeenCalled();
		expect(container.querySelector(".shell-detail")).toBeNull();
		expect(container.querySelector(".subagent-link")).toBeNull();
	});

	it("waits for an agent's Child Session and opens it when its id arrives", async () => {
		const view = render(ActivityRow, {
			props: {
				...props,
				part: {
					...agent,
					metadata: { providerTaskId: "agent", backgrounded: true },
				},
			},
		});
		expect(
			(view.container.querySelector("button") as HTMLButtonElement).disabled,
		).toBe(true);
		await fireEvent.click(
			view.container.querySelector("button") as HTMLButtonElement,
		);
		expect(openTask).not.toHaveBeenCalled();
		expect(view.container.querySelector(".tool-result")).toBeNull();
		await view.rerender(props);
		await fireEvent.click(
			view.container.querySelector("button") as HTMLButtonElement,
		);
		expect(openTask).toHaveBeenCalledOnce();
	});

	it("retains expansion and separate child navigation for foreground agents", async () => {
		const { container } = render(ActivityRow, {
			props: {
				...props,
				part: {
					...agent,
					metadata: { childSessionId: "child" },
				},
			},
		});
		await fireEvent.click(
			container.querySelector("button") as HTMLButtonElement,
		);
		expect(container.querySelector(".tool-result")?.textContent).toContain(
			"Launch result",
		);
		await fireEvent.click(
			container.querySelector(".subagent-link") as HTMLButtonElement,
		);
		expect(openSession).toHaveBeenCalledWith("child");
		expect(openTask).not.toHaveBeenCalled();
	});
});

const liveTool: ToolMessage = {
	type: "tool",
	uuid: "codex/tool",
	id: "codex-tool",
	name: "mcp__fixture__lookup",
	status: "running",
	input: { tool: "Unknown", name: "mcp__fixture__lookup", raw: {} },
	metadata: { output: "Lookup started\n" },
};

describe("tool live output", () => {
	it("expands provider-neutral live output in an activity row and replaces it with the final result", async () => {
		const view = render(ActivityRow, {
			props: { part: liveTool, liveTasks: [], taskListedAt: new Map() },
		});
		await fireEvent.click(
			view.container.querySelector("button") as HTMLButtonElement,
		);
		expect(view.container.querySelector(".tool-result")?.textContent).toContain(
			"Lookup started",
		);
		await view.rerender({
			part: { ...liveTool, status: "completed", result: "Final lookup result" },
		});
		expect(view.container.querySelector(".tool-result")?.textContent).toContain(
			"Final lookup result",
		);
		expect(
			view.container.querySelector(".tool-result")?.textContent,
		).not.toContain("Lookup started");
	});

	it("expands provider-neutral live output in a generic tool card and updates it in place", async () => {
		const view = render(ToolGenericCard, { props: { message: liveTool } });
		await fireEvent.click(
			view.container.querySelector("button") as HTMLButtonElement,
		);
		expect(view.container.querySelector(".tool-result")?.textContent).toContain(
			"Lookup started",
		);
		await view.rerender({
			message: {
				...liveTool,
				metadata: { output: "Lookup started\nFound the record\n" },
			},
		});
		expect(view.container.querySelector(".tool-result")?.textContent).toContain(
			"Found the record",
		);
	});

	it("keeps Cursor live output visible", async () => {
		const view = render(ToolGenericCard, {
			props: {
				message: {
					...liveTool,
					metadata: {
						cursorToolType: "mcpToolCall",
						output: "Cursor lookup started\n",
					},
				},
			},
		});
		await fireEvent.click(
			view.container.querySelector("button") as HTMLButtonElement,
		);
		expect(view.container.querySelector(".tool-result")?.textContent).toContain(
			"Cursor lookup started",
		);
	});
});
