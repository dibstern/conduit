import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { PermissionId, Toast as ToastType } from "../../types.js";
import NotificationStack from "./NotificationStack.svelte";

const meta = {
	title: "Overlays/NotificationStack",
	component: NotificationStack,
	tags: ["autodocs"],
	parameters: {
		docs: { story: { inline: false, height: "200px" } },
	},
	beforeEach: () => {
		uiState.toasts = [];
		permissionsState.pendingPermissions = [];
		permissionsState.remoteQuestionCounts = new Map();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

function setToasts(toasts: ToastType[]): void {
	uiState.toasts = toasts;
}

function setupAttention(opts: {
	permissions?: Array<{ id: string; sessionId: string; toolName: string }>;
	questionSessions?: string[];
	sessionTitles?: Record<string, string>;
}) {
	flushSync(() => {
		sessionState.currentId = "ses_current";
		sessionState.allSessions = Object.entries(opts.sessionTitles ?? {}).map(
			([id, title]) => ({
				id,
				title,
				createdAt: Date.now(),
			}),
		) as typeof sessionState.allSessions;

		permissionsState.pendingPermissions = (opts.permissions ?? []).map((p) => ({
			...p,
			requestId: p.id as PermissionId,
			toolName: p.toolName,
			toolInput: {},
		}));

		permissionsState.remoteQuestionCounts = new Map(
			(opts.questionSessions ?? []).map((s) => [s, 1] as const),
		);
	});
}

export const ToastsOnly: Story = {
	beforeEach: () => {
		setToasts([
			{ id: "t1", message: "File saved", variant: "default", duration: 999999 },
			{
				id: "t2",
				message: "Connection lost",
				variant: "warn",
				duration: 999999,
			},
		]);
	},
};

export const AttentionOnly: Story = {
	beforeEach: () => {
		setupAttention({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			questionSessions: ["ses_other2"],
			sessionTitles: {
				ses_other1: "Fix authentication bug",
				ses_other2: "API redesign",
			},
		});
	},
};

export const Combined: Story = {
	name: "Permissions + Questions + Toasts",
	beforeEach: () => {
		setupAttention({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
				{ id: "perm-2", sessionId: "ses_other1", toolName: "edit" },
			],
			questionSessions: ["ses_other2"],
			sessionTitles: {
				ses_other1: "Fix authentication bug",
				ses_other2: "API redesign",
			},
		});
		setToasts([
			{
				id: "t1",
				message: "Copied to clipboard",
				variant: "default",
				duration: 999999,
			},
			{ id: "t2", message: "Rate limited", variant: "warn", duration: 999999 },
		]);
	},
};
