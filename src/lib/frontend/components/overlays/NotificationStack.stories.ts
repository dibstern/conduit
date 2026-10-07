import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import {
	applyApprovalEnvelope,
	clearAllPermissions,
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

		applyApprovalEnvelope({
			_tag: "snapshot",
			sequence: 1,
			rows: (opts.permissions ?? []).map((p) => ({
				_tag: "permission" as const,
				requestId: p.id as PermissionId,
				sessionId: p.sessionId,
				toolName: p.toolName,
				toolInput: {},
			})),
		});
	});
}

export const ToastsOnly: Story = {
	beforeEach: () => {
		setToasts([
			{
				id: "t1",
				title: "File saved",
				actions: [],
				variant: "default",
				duration: 999999,
			},
			{
				id: "t2",
				title: "Connection lost",
				actions: [],
				variant: "warn",
				duration: 999999,
			},
			{
				id: "t3",
				title: "Failed to reconnect",
				actions: [],
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
				title: "Failed to load sessions",
				actions: [],
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
				title: "Copied to clipboard",
				actions: [],
				variant: "default",
				duration: 999999,
			},
			{
				id: "t2",
				title: "Rate limited",
				actions: [],
				variant: "warn",
				duration: 999999,
			},
			{
				id: "t3",
				title: "Failed to send message",
				actions: [],
				variant: "error",
				duration: 999999,
			},
		]);
	},
};
