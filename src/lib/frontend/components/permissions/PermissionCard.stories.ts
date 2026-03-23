import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { PermissionId, PermissionRequest } from "../../types.js";
import PermissionCard from "./PermissionCard.svelte";

// ─── Mock data ──────────────────────────────────────────────────────────────

const mockPermissionPending: PermissionRequest = {
	requestId: "perm-001" as PermissionId,
	toolName: "bash",
	toolUseId: "tu-001",
	sessionId: "",
};

const mockPermissionWithToolInput: PermissionRequest = {
	requestId: "perm-002" as PermissionId,
	toolName: "bash",
	toolInput: {
		command: "rm -rf /tmp/build && mkdir -p /tmp/build/output",
	},
	toolUseId: "tu-002",
	sessionId: "",
};

const mockPermissionEditFile: PermissionRequest = {
	requestId: "perm-003" as PermissionId,
	toolName: "edit",
	toolInput: {
		file_path: "/src/lib/auth.ts",
		old_string: "const ttl = 900;",
		new_string: "const ttl = 3600;",
	},
	toolUseId: "tu-003",
	sessionId: "",
};

// ─── Meta ───────────────────────────────────────────────────────────────────

const meta = {
	title: "Permissions/PermissionCard",
	component: PermissionCard,
	tags: ["autodocs"],
} satisfies Meta<typeof PermissionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── Stories ────────────────────────────────────────────────────────────────

export const Pending: Story = {
	args: { request: mockPermissionPending },
};

export const WithToolInput: Story = {
	args: { request: mockPermissionWithToolInput },
};

export const EditFileInput: Story = {
	args: { request: mockPermissionEditFile },
};
