import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolItem from "../../../src/lib/frontend/components/chat/ToolItem.svelte";
import ToolSubagentCard from "../../../src/lib/frontend/components/chat/ToolSubagentCard.svelte";
import { switchToSession } from "../../../src/lib/frontend/stores/session.svelte.js";
import type { ToolMessage } from "../../../src/lib/frontend/types.js";

vi.mock("../../../src/lib/frontend/stores/session.svelte.js", () => ({
	switchToSession: vi.fn(),
}));

describe("ToolSubagentCard", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("uses canonical Task subagentType for the agent title", () => {
		const message: ToolMessage = {
			type: "tool",
			uuid: "tool-msg-1",
			id: "tool-task-1",
			name: "Task",
			status: "running",
			input: {
				tool: "Task",
				description: "Audit Claude provider",
				prompt: "Find SDK mapping gaps",
				subagentType: "explore",
			},
		};

		render(ToolSubagentCard, {
			props: {
				message,
				groupRadius: "",
			},
		});

		expect(screen.getByText("explore Agent")).toBeTruthy();
	});

	it("navigates with Claude childSessionId metadata", async () => {
		const message: ToolMessage = {
			type: "tool",
			uuid: "tool-msg-1",
			id: "tool-task-1",
			name: "Task",
			status: "completed",
			input: {
				tool: "Task",
				description: "Audit Claude provider",
				prompt: "Find SDK mapping gaps",
				subagentType: "explore",
			},
			metadata: { childSessionId: "claude-subagent-abc" },
		};

		render(ToolSubagentCard, {
			props: {
				message,
				groupRadius: "",
			},
		});

		await fireEvent.click(screen.getByRole("button"));

		expect(switchToSession).toHaveBeenCalledWith("claude-subagent-abc");
	});

	it("renders Claude Agent tool messages as subagent cards", async () => {
		const message: ToolMessage = {
			type: "tool",
			uuid: "tool-msg-agent-1",
			id: "tool-agent-1",
			name: "Agent",
			status: "running",
			input: {
				tool: "Unknown",
				name: "Agent",
				raw: {
					description: "Audit Effect service boundaries",
					prompt: "Inspect Effect migration status",
					subagent_type: "explore",
				},
			},
			metadata: { childSessionId: "claude-subagent-agent" },
		};

		render(ToolItem, {
			props: { message },
		});

		expect(screen.getByText("explore Agent")).toBeTruthy();
		expect(screen.getByText("Audit Effect service boundaries")).toBeTruthy();

		await fireEvent.click(screen.getByRole("button"));

		expect(switchToSession).toHaveBeenCalledWith("claude-subagent-agent");
	});
});
