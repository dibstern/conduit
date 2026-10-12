import type { Meta, StoryObj } from "@storybook/svelte-vite";
import {
	mockSystemError,
	mockSystemErrorWithDetails,
	mockSystemInfo,
} from "../../stories/mocks.js";
import SystemMessage from "./SystemMessage.svelte";

const meta = {
	title: "Chat/SystemMessage",
	component: SystemMessage,
	tags: ["autodocs"],
} satisfies Meta<typeof SystemMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
	args: { message: mockSystemInfo },
};

export const ErrorState: Story = {
	args: { message: mockSystemError },
};

export const WithDetails: Story = {
	args: { message: mockSystemErrorWithDetails },
};

/**
 * Hovers the details-bearing card, not the plain info card. The info card has no
 * hover treatment by design — it is inert — so a hover story over it captured a
 * frame byte-identical to Info and asserted nothing.
 */
export const Hover: Story = {
	...WithDetails,
	parameters: { pseudo: { hover: true } },
};

/** A failed compaction stays a standalone notice: it is a failure, not a boundary. */
export const CompactionFailed: Story = {
	args: {
		message: {
			type: "system",
			uuid: "compaction-failed",
			text: "Compaction failed: prompt is too long",
			variant: "error",
			compaction: "failed",
		},
	},
};

export const SetupRunning: Story = {
	args: {
		message: {
			type: "system",
			uuid: "setup-running",
			text: "Setup script",
			setup: { source: "daemon", status: "running" },
			setupOutput: "Installing dependencies…\nResolved 128 packages\n",
		},
	},
};

export const SetupSucceeded: Story = {
	args: {
		message: {
			type: "system",
			uuid: "setup-succeeded",
			text: "Setup script",
			setup: { source: "file", status: "succeeded", exitCode: 0 },
			setupOutput: "Dependencies installed\nWorkspace ready\n",
		},
	},
};

export const SetupFailed: Story = {
	args: {
		message: {
			type: "system",
			uuid: "setup-failed",
			text: "Setup script",
			setup: { source: "daemon", status: "failed", exitCode: 7 },
			setupOutput:
				"Installing dependencies\nError: dependency download failed\n",
		},
	},
};

export const SetupTimedOut: Story = {
	args: {
		message: {
			type: "system",
			uuid: "setup-timed-out",
			text: "Setup script",
			setup: { source: "file", status: "timed_out" },
			setupOutput: "Waiting for dependency server…\n",
		},
	},
};

export const SetupInvalidProjectFile: Story = {
	args: {
		message: {
			type: "system",
			uuid: "setup-invalid-project-file",
			text: "Setup script",
			setup: {
				source: "file",
				status: "skipped",
				message:
					"Invalid conduit.json: setupScript must be a string. Edit the file before creating the next worktree.",
			},
		},
	},
};
