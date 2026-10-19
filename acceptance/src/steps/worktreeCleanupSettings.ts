import { expect, type Page } from "@playwright/test";
import { DEFAULT_WORKTREE_CLEANUP } from "../../../src/lib/contracts/worktree.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StepHandler } from "../runtime.js";
import { requireRpcControl } from "./shared.js";

const cleanupGroup = (page: Page) =>
	page.getByRole("region", { name: "Worktree cleanup", exact: true });

const heldCleanups = new WeakMap<Page, () => void>();

export const worktreeCleanupSettingsHandlers: StepHandler[] = [
	{
		name: "seed a cleanup report",
		match:
			/^cleaning up now removes that session's worktree because "([^"]+)", keeps (\S+) because "([^"]+)" and fails (\S+) because "([^"]+)"$/,
		run: ({ world, match }) => {
			const entry = (sessionId: string, path: string, reason: string) => ({
				projectSlug: "myapp",
				sessionId,
				path,
				reason,
			});
			requireRpcControl(world.page).setStubs({
				CleanUpWorktreesNow: () => ({
					removed: [
						entry("row-opencode", "/worktrees/opencode", match[1] ?? ""),
					],
					kept: [entry("row-kept", match[2] ?? "", match[3] ?? "")],
					failed: [entry("row-failed", match[4] ?? "", match[5] ?? "")],
				}),
			});
		},
	},
	{
		name: "seed the delete rule",
		match:
			/^worktree cleanup (asks about|removes) worktrees of deleted sessions$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).setStubs({
				GetWorktreeCleanupSetting: () => ({
					worktreeCleanup: {
						...DEFAULT_WORKTREE_CLEANUP,
						onDelete: match[1] === "removes",
					},
				}),
			});
		},
	},
	{
		name: "hold cleanup until the server fails it",
		match: /^cleaning up now waits for the server$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setStubs({
				CleanUpWorktreesNow: () =>
					new Promise<never>((_, reject) =>
						heldCleanups.set(world.page, () =>
							reject(new WsRpcError({ message: "Cleanup failed" })),
						),
					),
			});
		},
	},
	{
		name: "fail the held cleanup",
		match: /^the server fails the cleanup$/,
		run: ({ world }) => {
			const fail = heldCleanups.get(world.page);
			if (!fail) throw new Error("No cleanup is waiting for the server");
			fail();
		},
	},
	{
		name: "expand Worktree cleanup",
		match: /^I expand Worktree cleanup$/,
		run: async ({ world }) => {
			const toggle = cleanupGroup(world.page).getByRole("button", {
				name: /^Worktree cleanup/,
			});
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "choose what keeps a worktree",
		match: /^I keep worktrees with (.+)$/,
		run: async ({ world, match }) => {
			await cleanupGroup(world.page)
				.getByRole("combobox", { name: "Keep worktrees with" })
				.selectOption({ label: match[1] ?? "" });
		},
	},
	{
		name: "assert the saved keep rule",
		match: /^the worktree cleanup keep rule is saved as (\S+)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "SetWorktreeCleanupSetting" &&
					(payload["worktreeCleanup"] as { keepWhen?: unknown } | undefined)
						?.keepWhen === match[1],
			);
		},
	},
	{
		name: "assert the delete rule",
		match: /^deleting a session is set to "([^"]+)"$/,
		run: async ({ world, match }) => {
			const select = cleanupGroup(world.page).getByRole("combobox", {
				name: "When a session is deleted",
			});
			await expect(select.locator("option:checked")).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "choose the delete rule",
		match: /^I set deleting a session to "([^"]+)"$/,
		run: async ({ world, match }) => {
			await cleanupGroup(world.page)
				.getByRole("combobox", { name: "When a session is deleted" })
				.selectOption({ label: match[1] ?? "" });
		},
	},
	{
		name: "assert the saved delete rule",
		match: /^the worktree cleanup delete rule is saved as (true|false)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "SetWorktreeCleanupSetting" &&
					(payload["worktreeCleanup"] as { onDelete?: unknown } | undefined)
						?.onDelete ===
						(match[1] === "true"),
			);
		},
	},
	{
		name: "assert the keep note",
		match:
			/^the worktree cleanup keep note is a (warning|note) reading "([^"]+)"$/,
		run: async ({ world, match }) => {
			const group = cleanupGroup(world.page);
			const other = match[1] === "warning" ? "note" : "warning";
			await expect(
				group.getByTestId(`settings-cleanup-keep-${match[1]}`),
			).toHaveText(match[2] ?? "");
			await expect(
				group.getByTestId(`settings-cleanup-keep-${other}`),
			).toHaveCount(0);
		},
	},
	{
		name: "run cleanup now",
		match: /^I run worktree cleanup now$/,
		run: async ({ world }) => {
			await cleanupGroup(world.page)
				.getByTestId("settings-cleanup-run")
				.click();
		},
	},
	{
		name: "assert the cleanup button",
		match:
			/^the worktree cleanup button reads "([^"]+)" and is (enabled|disabled)$/,
		run: async ({ world, match }) => {
			const button = cleanupGroup(world.page).getByTestId(
				"settings-cleanup-run",
			);
			await expect(button).toHaveText(match[1] ?? "");
			await (match[2] === "enabled"
				? expect(button).toBeEnabled()
				: expect(button).toBeDisabled());
		},
	},
	{
		name: "assert the cleanup counts",
		match: /^the worktree cleanup report reads "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				cleanupGroup(world.page).getByTestId("settings-cleanup-counts"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert the cleanup failure",
		match: /^the worktree cleanup report alerts "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				cleanupGroup(world.page)
					.getByTestId("settings-cleanup-report")
					.getByRole("alert"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "expand the cleanup report",
		match: /^I expand the worktree cleanup report$/,
		run: async ({ world }) => {
			const toggle = cleanupGroup(world.page)
				.getByTestId("settings-cleanup-report")
				.getByRole("button");
			await toggle.click();
			await expect(toggle).toHaveAttribute("aria-expanded", "true");
		},
	},
	{
		name: "assert a cleanup report entry",
		match:
			/^the worktree cleanup report lists "([^"]+)" as (removed|kept|failed) because "([^"]+)"$/,
		run: async ({ world, match }) => {
			const outcome = match[2] ?? "";
			const entry = cleanupGroup(world.page)
				.getByRole("region", {
					name: outcome.charAt(0).toUpperCase() + outcome.slice(1),
					exact: true,
				})
				.getByTestId("settings-cleanup-entry");
			await expect(entry).toHaveCount(1);
			await expect(entry.locator("span")).toHaveText([
				match[1] ?? "",
				match[3] ?? "",
			]);
			await entry.scrollIntoViewIfNeeded();
			await world.page.evaluate(() =>
				(document.activeElement as HTMLElement | null)?.blur(),
			);
		},
	},
];
