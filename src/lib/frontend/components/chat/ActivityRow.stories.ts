import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	mockAssistantSimple,
	mockThinkingActive,
	mockThinkingDone,
	mockToolCompleted,
	mockToolError,
} from "../../stories/mocks.js";
import ActivityRow from "./ActivityRow.svelte";

const meta = {
	title: "Chat/ActivityRow",
	component: ActivityRow,
	parameters: { layout: "padded" },
	args: { liveTasks: [], taskListedAt: new Map<string, number>() },
} satisfies Meta<typeof ActivityRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Read: Story = {
	args: { part: mockToolCompleted, duration: 2500 },
	globals: { theme: "dark" },
	play: async ({ canvasElement }) => {
		const row = within(canvasElement).getByRole("button");
		const verb = canvasElement.querySelector(".tool-name");
		const argument = canvasElement.querySelector(".tool-desc");
		const time = canvasElement.querySelector("time");
		if (!verb || !argument || !time) throw new Error("Missing activity row");
		expect(row.getBoundingClientRect().height).toBe(26);
		expect(getComputedStyle(verb).fontSize).toBe("12.5px");
		expect(getComputedStyle(verb).fontWeight).toBe("400");
		expect(getComputedStyle(argument).fontSize).toBe("11.5px");
		expect(getComputedStyle(time).fontSize).toBe("10.12px");
	},
};
export const ReadLight: Story = { ...Read, globals: { theme: "light" } };
export const ErrorState: Story = {
	args: { part: mockToolError, duration: 1400 },
};
export const Thinking: Story = {
	args: { part: mockThinkingDone, duration: 42000 },
};
export const ThinkingLive: Story = {
	args: { part: mockThinkingActive, live: true },
	play: async ({ canvasElement }) => {
		await expect(
			canvasElement.querySelector('.thinking-item [data-flow-glyph="running"]'),
		).toBeVisible();
	},
};
export const ProjectedLive: Story = {
	args: {
		part: {
			type: "tool",
			uuid: "live-row",
			id: "live-tool",
			name: "Bash",
			status: "completed",
			input: { command: "pnpm acceptance:visual" },
		},
		live: true,
		duration: 250000,
	},
	play: async ({ canvasElement }) => {
		await expect(
			canvasElement.querySelector('.tool-item [data-flow-glyph="running"]'),
		).toBeVisible();
	},
};
export const RunningCodexBash: Story = {
	args: {
		part: {
			type: "tool",
			uuid: "codex-command",
			id: "codex-command",
			name: "Bash",
			status: "running",
			input: { tool: "Bash", command: "printf 'first line\\nsecond line\\n'" },
			metadata: { output: "first line\nsecond line\n" },
		},
		live: true,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByRole("button");
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await expect(
			canvasElement.querySelector(".shell-command"),
		).toHaveTextContent("printf");
		await expect(
			canvasElement.querySelector(".shell-output"),
		).toHaveTextContent(/first line\s+second line/);
	},
};

export const ExpandedBash: Story = {
	args: {
		part: {
			type: "tool",
			uuid: "split-shell",
			id: "split-shell",
			name: "Bash",
			status: "completed",
			input: {
				command: `ROOT=/tmp cat <<'EOF'\n$BODY stays plain --flag\nEOF\nprintf '%s' $ROOT/file && ls -la | head -c 100 # inspect`,
			},
			result: `${Array.from({ length: 12 }, (_, i) => `Output line ${i + 1}: ${"wrapped output ".repeat(6)}`).join("\n")}\nShell cwd was reset to /tmp/project`,
			metadata: { exitCode: 0 },
			createdAt: 100,
			endedAt: 540,
		},
	},
	globals: { theme: "dark" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByRole("button");
		await userEvent.click(row);
		await expect(
			canvasElement.querySelector(".shell-command .heredoc"),
		).toHaveTextContent("'EOF'");
		await expect(
			canvasElement.querySelector(".shell-footer"),
		).toHaveTextContent("✓ exit 0 · 440ms");
		await expect(
			canvas.getByTitle("Shell cwd was reset to /tmp/project"),
		).toHaveTextContent("cwd reset");
		await expect(
			canvasElement.querySelector(".shell-output"),
		).not.toHaveTextContent("Shell cwd was reset");
		const more = await canvas.findByRole("button", { name: "Show all output" });
		await expect(more).toBeVisible();
		await userEvent.click(more);
		await expect(canvasElement.querySelector(".shell-output")).not.toHaveClass(
			"clipped",
		);
		await expect(
			canvas.queryByRole("button", { name: "Show all output" }),
		).not.toBeInTheDocument();
		const range = document.createRange();
		range.selectNodeContents(row);
		window.getSelection()?.addRange(range);
		row.click();
		await expect(row).toHaveAttribute("aria-expanded", "true");
		window.getSelection()?.removeAllRanges();
	},
};
export const ExpandedBashLight: Story = {
	...ExpandedBash,
	globals: { theme: "light" },
};
export const Message: Story = {
	args: { part: mockAssistantSimple, duration: 12000 },
};
export const MessageLight: Story = { ...Message, globals: { theme: "light" } };
export const NumberedMessage: Story = {
	...Message,
	args: { ...Message.args, messageNumber: 26 },
};
export const NumberedMessageLight: Story = {
	...NumberedMessage,
	globals: { theme: "light" },
};
export const ExpandedRead: Story = {
	...Read,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByRole("button");
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await expect(canvasElement.querySelector(".tool-result")).toHaveTextContent(
			"authenticate(token: string)",
		);
		const result = canvasElement.querySelector(".tool-result");
		if (!result) throw new Error("Missing activity result");
		expect(
			result.getBoundingClientRect().left - row.getBoundingClientRect().left,
		).toBe(22);
		expect(getComputedStyle(result).borderWidth).toBe("0px");
	},
};
