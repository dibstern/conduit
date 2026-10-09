import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { fn } from "storybook/test";
import { clearAllPermissions } from "../../stores/permissions.svelte.js";
import { clearSessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { Toast as ToastType } from "../../types.js";
import NotificationStack from "./NotificationStack.svelte";

const meta = {
	title: "Overlays/Toast",
	component: NotificationStack,
	tags: ["autodocs"],
	parameters: {
		docs: { story: { inline: false, height: "200px" } },
	},
	beforeEach: () => {
		uiState.toasts = [];
		clearAllPermissions();
		clearSessionState();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Set toasts directly, with no auto-dismiss timer. */
function show(...toasts: Omit<ToastType, "id" | "duration">[]): () => void {
	return () => {
		uiState.toasts = toasts.map((toast, index) => ({
			id: `story-${index}`,
			duration: 999999,
			...toast,
		}));
	};
}

// One story per variant x {no action, primary only, primary + secondary +
// dismiss}. The copy is what the app actually says in each situation.

export const DefaultToast: Story = {
	beforeEach: show({
		title: "Copied resume command",
		variant: "default",
		actions: [],
	}),
};

export const DefaultWithPrimary: Story = {
	name: "Default with primary (undo)",
	beforeEach: show({
		title: "Moved to Settled",
		body: "Fix navigation focus after closing the sheet",
		variant: "default",
		actions: [{ label: "Undo", run: fn(), kind: "primary" }],
	}),
};

export const DefaultWithAllActions: Story = {
	name: "Default with primary, secondary and dismiss",
	beforeEach: show({
		title: "Switched to personal",
		body: "Now on personal; work2claude hit its weekly limit.",
		emphasis: "personal",
		variant: "default",
		actions: [
			{ label: "Undo", run: fn(), kind: "primary" },
			{ label: "What carried over?", run: fn(), kind: "secondary" },
			{ label: "Later", kind: "dismiss" },
		],
	}),
};

export const WarnToast: Story = {
	beforeEach: show({
		title: "Context window is almost full",
		body: "92% used. Compact or start a new session soon.",
		variant: "warn",
		actions: [],
	}),
};

export const WarnWithPrimary: Story = {
	name: "Warn with primary",
	beforeEach: show({
		title: "Terminal input was not delivered",
		variant: "warn",
		actions: [{ label: "Retry", run: fn(), kind: "primary" }],
	}),
};

export const WarnWithAllActions: Story = {
	name: "Warn with primary, secondary and dismiss",
	beforeEach: show({
		title: "work2claude is out until Mon 9:00",
		body: "personal has 77% of its week left.",
		emphasis: "personal",
		variant: "warn",
		actions: [
			{ label: "Switch and resend", run: fn(), kind: "primary" },
			{ label: "Other…", run: fn(), kind: "secondary" },
			{ label: "Later", kind: "dismiss" },
		],
	}),
};

export const ErrorToast: Story = {
	beforeEach: show({
		title: "Failed to send message",
		variant: "error",
		actions: [],
	}),
};

export const ErrorWithPrimary: Story = {
	name: "Error with primary",
	beforeEach: show({
		title: "Failed to restart conduit",
		body: "The server did not come back within 10 seconds.",
		variant: "error",
		actions: [{ label: "Retry", run: fn(), kind: "primary" }],
	}),
};

export const ErrorWithAllActions: Story = {
	name: "Error with primary, secondary and dismiss",
	beforeEach: show({
		title: "Couldn't switch account",
		body: "personal is signed out. Sign in again to use it.",
		emphasis: "personal",
		variant: "error",
		actions: [
			{ label: "Sign in", run: fn(), kind: "primary" },
			{ label: "Other…", run: fn(), kind: "secondary" },
			{ label: "Later", kind: "dismiss" },
		],
	}),
};

export const MultipleToasts: Story = {
	beforeEach: show(
		{
			title: "Marked unread",
			body: "Composer redesign",
			variant: "default",
			actions: [{ label: "Undo", run: fn(), kind: "primary" }],
		},
		{ title: "Connection lost", variant: "warn", actions: [] },
	),
};
