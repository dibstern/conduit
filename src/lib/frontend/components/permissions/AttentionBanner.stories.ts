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
import type { PermissionId, SessionInfo } from "../../types.js";
import NotificationStack from "../overlays/NotificationStack.svelte";

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

const meta = {
	title: "Overlays/AttentionBanner",
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

export const Hover: Story = {
	...SinglePermission,
	parameters: { pseudo: { hover: true } },
};
