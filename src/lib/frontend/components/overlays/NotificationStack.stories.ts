import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import {
	clearAllPermissions,
	handlePermissionRequest,
} from "../../stores/permissions.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type {
	PermissionId,
	SessionInfo,
	Toast as ToastType,
} from "../../types.js";
import NotificationStack from "./NotificationStack.svelte";

let sequence = 0;

type Row = Pick<SessionInfo, "id" | "title"> & Partial<SessionInfo>;

function seedSessions(rows: readonly Row[]): void {
	const sessions: SessionInfo[] = rows.map((row) => ({
		status: "idle",
		...row,
	}));
	applySessionChange({
		_tag: "snapshot",
		rows: sessions,
		sequence: ++sequence,
	});
	applySessionChange({ _tag: "synchronized" });
}

const meta = {
	title: "Overlays/NotificationStack",
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
		seedSessions(
			Object.entries(opts.sessionTitles ?? {}).map(([id, title]) => ({
				id,
				title,
				status: "idle" as const,
				createdAt: 1_735_689_600_000,
				pendingQuestionCount: opts.questionSessions?.includes(id) ? 1 : 0,
			})),
		);

		for (const p of opts.permissions ?? []) {
			handlePermissionRequest({
				type: "permission_request",
				requestId: p.id as PermissionId,
				sessionId: p.sessionId,
				toolName: p.toolName,
				toolInput: {},
			});
		}
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
			{
				id: "t3",
				message: "Failed to reconnect",
				variant: "error",
				duration: 999999,
			},
		]);
	},
};

export const ErrorToast: Story = {
	beforeEach: () => {
		setToasts([
			{
				id: "error-toast",
				message: "Failed to load sessions",
				variant: "error",
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
			{
				id: "t3",
				message: "Failed to send message",
				variant: "error",
				duration: 999999,
			},
		]);
	},
};
