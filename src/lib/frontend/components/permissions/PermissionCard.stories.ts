import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import type { PermissionId, PermissionRequest } from "../../types.js";
import PermissionCard from "./PermissionCard.svelte";

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

const meta = {
	title: "Chat/PermissionCard",
	component: PermissionCard,
	tags: ["autodocs"],
} satisfies Meta<typeof PermissionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
	args: { request: mockPermissionPending },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const allow = canvas.getByRole("button", { name: "Allow" });
		const always = canvas.getByRole("button", { name: "Always allow" });
		const deny = canvas.getByRole("button", { name: "Deny" });
		for (const button of [allow, always, deny]) {
			const style = getComputedStyle(button);
			await expect(button.getBoundingClientRect().height).toBe(28);
			await expect(parseFloat(style.borderRadius)).toBeGreaterThanOrEqual(999);
			await expect(style.borderTopWidth).toBe("0px");
			await expect(
				parseFloat(getComputedStyle(button, "::before").minHeight),
			).toBeGreaterThanOrEqual(44);
		}
		await expect(getComputedStyle(always).color).toBe(
			getComputedStyle(deny).color,
		);
		await expect(getComputedStyle(allow).color).not.toBe(
			getComputedStyle(deny).color,
		);
		const marker = canvasElement.querySelector(".permission-waiting-marker");
		const toolName = canvas.getByText("bash");
		await expect(marker).not.toBeNull();
		const palette = canvasElement.ownerDocument.createElement("span");
		palette.style.color = "var(--color-status-ask)";
		canvasElement.append(palette);
		if (marker)
			await expect(getComputedStyle(marker).backgroundColor).toBe(
				getComputedStyle(palette).color,
			);
		palette.remove();
		await expect(getComputedStyle(toolName).fontFamily).not.toContain("Mono");
		await expect(getComputedStyle(toolName).color).toBe(
			getComputedStyle(deny).color,
		);
		const card = canvasElement.querySelector(".permission-card");
		if (!card) throw new Error("Missing permission card");
		await expect(getComputedStyle(card).borderTopWidth).toBe("0px");
	},
};

export const PendingLight: Story = { ...Pending, globals: { theme: "light" } };

export const WithToolInput: Story = {
	args: { request: mockPermissionWithToolInput },
};

export const EditFileInput: Story = {
	args: { request: mockPermissionEditFile },
};

export const Hover: Story = {
	...Pending,
	parameters: { pseudo: { hover: true } },
};
