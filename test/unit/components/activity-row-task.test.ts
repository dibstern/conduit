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
		expect(container.querySelector(".tool-result")).toBeNull();
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
