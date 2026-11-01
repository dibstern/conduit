import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, waitFor } from "storybook/test";
import { flushSync } from "svelte";
import {
	applyApprovalEnvelope,
	clearAllPermissions,
} from "../../stores/permissions.svelte.js";
import { clearSessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
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
		accountId: null,
		status: "idle",
		projectSlug: "conduit",
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
		openSessionForSetup("ses_current", "conduit");
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
			sequence: ++sequence,
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

const titles = {
	ses_other1: "Fix authentication bug",
	ses_other2: "API redesign",
	ses_other3: "Release notes",
};

/** Release notes was already waiting at load, so only the two arrivals toast. */
export const ArrivalToasts: Story = {
	name: "Other sessions start needing you",
	beforeEach: () => {
		setupAttention({ questionSessions: ["ses_other3"], sessionTitles: titles });
	},
	play: async () => {
		await expect(
			document.querySelectorAll('[data-testid="toast"]'),
		).toHaveLength(0);
		setupAttention({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			questionSessions: ["ses_other2", "ses_other3"],
			sessionTitles: titles,
		});
		await waitFor(() =>
			expect(
				[...document.querySelectorAll('[data-testid="toast"]')].map((toast) =>
					toast.textContent?.trim(),
				),
			).toEqual([
				expect.stringContaining("API redesign has a question"),
				expect.stringContaining("Fix authentication bug needs approval"),
			]),
		);
	},
};
