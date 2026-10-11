import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BackgroundTaskList from "../../../src/lib/frontend/components/session/BackgroundTaskList.svelte";
import {
	taskDrawer,
	tasksPanel,
} from "../../../src/lib/frontend/components/session/background-tasks.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import type { BackgroundTask } from "../../../src/lib/shared-types.js";

describe("BackgroundTaskList drill-in", () => {
	beforeEach(() => {
		sessionViewState.compact = false;
		taskDrawer.task = null;
		tasksPanel.open = false;
	});
	afterEach(() => {
		cleanup();
		taskDrawer.task = null;
	});

	it("offers drill-in only after an agent's Child Session becomes available", async () => {
		const agent: BackgroundTask = {
			id: "agent",
			type: "local_agent",
			description: "Review the router",
			firstSeenAt: Date.now(),
		};
		const view = render(BackgroundTaskList, { props: { tasks: [agent] } });
		expect(
			screen.queryByRole("button", { name: "Open Review the router" }),
		).toBeNull();
		await fireEvent.click(screen.getByText(agent.description));
		expect(taskDrawer.task).toBeNull();

		await view.rerender({ tasks: [{ ...agent, childSessionId: "child" }] });
		await fireEvent.click(
			screen.getByRole("button", { name: "Open Review the router" }),
		);
		expect(taskDrawer.task?.sessionId).toBe("child");
	});

	it("keeps shells inert even if stale data still carries a Child Session id", async () => {
		render(BackgroundTaskList, {
			props: {
				tasks: [
					{
						id: "shell",
						type: "local_bash",
						description: "Run the server",
						firstSeenAt: Date.now(),
						childSessionId: "old-shell-child",
					},
				],
			},
		});
		expect(screen.queryByRole("button")).toBeNull();
		await fireEvent.click(screen.getByText("Run the server"));
		expect(taskDrawer.task).toBeNull();
	});

	it("stops by task id without opening the child or removing the row", async () => {
		const onstop = vi.fn();
		render(BackgroundTaskList, {
			props: {
				tasks: [
					{
						id: "agent",
						type: "local_agent",
						description: "Review the router",
						firstSeenAt: 0,
						childSessionId: "child",
					},
				],
				onstop,
			},
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Stop Review the router" }),
		);
		expect(onstop).toHaveBeenCalledWith("agent");
		expect(taskDrawer.task).toBeNull();
		expect(screen.getByText("Review the router")).toBeTruthy();
	});
});
