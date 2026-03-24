import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { flushSync } from "svelte";
import { permissionsState } from "../../stores/permissions.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import type { PermissionId } from "../../types.js";
import PermissionNotification from "./PermissionNotification.svelte";

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

		permissionsState.remoteQuestionSessions = new Set(
			opts.questionSessions ?? [],
		);
	});
}

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Permissions/PermissionNotification",
	component: PermissionNotification,
	tags: ["autodocs"],
} satisfies Meta<typeof PermissionNotification>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Stories ────────────────────────────────────────────────────────────────

export const SinglePermission: Story = {
	play: () => {
		setupState({
			permissions: [
				{ id: "perm-1", sessionId: "ses_other1", toolName: "bash" },
			],
			sessionTitles: { ses_other1: "Fix authentication bug" },
		});
	},
};

export const MultiplePermissions: Story = {
	play: () => {
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
	play: () => {
		setupState({
			questionSessions: ["ses_other1"],
			sessionTitles: { ses_other1: "API redesign" },
		});
	},
};

export const PermissionsAndQuestions: Story = {
	play: () => {
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
	play: () => {
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
