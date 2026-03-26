import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import {
	dispatch,
	resetNotifState,
} from "../../stores/notification-reducer.svelte.js";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { uiState } from "../../stores/ui.svelte.js";
import type { PermissionId } from "../../types.js";
import NotificationStack from "../overlays/NotificationStack.svelte";

// ─── Helpers ────────────────────────────────────────────────────────────────

function setupState(opts: {
	currentId?: string;
	permissions?: Array<{
		id: string;
		sessionId: string;
		toolName: string;
	}>;
	questionSessions?: string[];
	sessionTitles?: Record<string, string>;
}) {
	flushSync(() => {
		sessionState.currentId = opts.currentId ?? "ses_current";
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

		resetNotifState();
		for (const sid of opts.questionSessions ?? []) {
			dispatch({ type: "question_appeared", sessionId: sid });
		}
	});
}

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Overlays/AttentionBanner",
	component: NotificationStack,
	tags: ["autodocs"],
	parameters: {
		docs: { story: { inline: false, height: "200px" } },
	},
	beforeEach: () => {
		uiState.toasts = [];
		permissionsState.pendingPermissions = [];
		resetNotifState();
	},
} satisfies Meta<typeof NotificationStack>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Stories ────────────────────────────────────────────────────────────────

export const SinglePermission: Story = {
	beforeEach: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			sessionTitles: { ses_other1: "Fix authentication bug" },
		});
	},
};

export const MultiplePermissions: Story = {
	beforeEach: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
				{ id: "perm-2", sessionId: "ses_other1", toolName: "edit" },
				{ id: "perm-3", sessionId: "ses_other2", toolName: "bash" },
			],
			sessionTitles: {
				ses_other1: "Fix authentication bug",
				ses_other2: "Refactor database layer",
			},
		});
	},
};

export const SingleQuestion: Story = {
	beforeEach: () => {
		setupState({
			questionSessions: ["ses_other1"],
			sessionTitles: { ses_other1: "API redesign" },
		});
	},
};

export const PermissionsAndQuestions: Story = {
	beforeEach: () => {
		setupState({
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

export const MixedSameSession: Story = {
	name: "Same session has both",
	beforeEach: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			questionSessions: ["ses_other1"],
			sessionTitles: { ses_other1: "Fix authentication bug" },
		});
	},
};

export const NoNotifications: Story = {
	name: "Empty (hidden)",
};
