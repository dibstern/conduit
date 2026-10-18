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
		name: "fail the cleanup settings read",
		match: /^reading worktree cleanup settings fails$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setHandler(
				"GetWorktreeCleanupSetting",
				() => {
					throw new WsRpcError({ message: "Cleanup settings unavailable" });
				},
			);
		},
	},
	{
		name: "assert failed cleanup reads leave project edits disabled",
		match: /^project cleanup edits stay disabled after the read failure$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByText("Couldn't load worktree cleanup setting", {
					exact: true,
				}),
			).toBeVisible();
			for (const id of [
				"mode",
				"on-settle",
				"settled-after",
				"on-delete",
				"keep-when",
			]) {
				await expect(
					cleanupGroup(world.page).getByTestId(`settings-cleanup-${id}`),
				).toBeDisabled();
			}
		},
	},
	{
		name: "set the current cleanup project",
		match: /^the current cleanup project is (draft|routed) named "([^"]+)"$/,
		run: async ({ world, match }) => {
			const projects = [
				{ slug: "other", title: "Other project", folders: ["/other"] },
				{ slug: "myapp", title: match[2] ?? "", folders: ["/myapp"] },
			];
			const rpc = requireRpcControl(world.page);
			rpc.setDaemonList("SubscribeProjects", { projects });
			rpc.setResponse("GetProjects", { projects, current: "other" });
			const path = match[1] === "draft" ? "/new?project=myapp" : "/?p=myapp";
			await world.page.goto(new URL(path, world.page.url()).toString());
			await expect(world.page.locator("#layout")).toBeVisible();
		},
	},
	{
		name: "clear the current cleanup project",
		match: /^cleanup settings have no current project$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			rpc.setDaemonList("SubscribeProjects", { projects: [] });
			rpc.setResponse("GetProjects", { projects: [], current: null });
			rpc.setResponse("AttachProject", {
				projectSlug: null,
				sessionSlug: null,
			});
			await world.page.goto(new URL("/", world.page.url()).toString());
			await expect(world.page.locator("#layout")).toBeVisible();
		},
	},
	{
		name: "assert the cleanup scope picker",
		match: /^the cleanup scope picker offers All projects and "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				cleanupGroup(world.page)
					.getByTestId("settings-cleanup-scope")
					.locator("option"),
			).toHaveText(["All projects", match[1] ?? ""]);
		},
	},
	{
		name: "assert the cleanup scope picker is hidden",
		match: /^the cleanup scope picker is hidden$/,
		run: async ({ world }) => {
			await expect(
				cleanupGroup(world.page).getByTestId("settings-cleanup-scope"),
			).toHaveCount(0);
			await expect(
				cleanupGroup(world.page).getByTestId("settings-cleanup-mode"),
			).toHaveCount(0);
		},
	},
	{
		name: "choose the cleanup scope",
		match: /^I choose cleanup scope "([^"]+)"$/,
		run: async ({ world, match }) => {
			await cleanupGroup(world.page)
				.getByTestId("settings-cleanup-scope")
				.selectOption({ label: match[1] ?? "" });
		},
	},
	{
		name: "frame the project cleanup controls",
		match: /^the project cleanup controls are framed for review$/,
		run: async ({ world }) => {
			await cleanupGroup(world.page).evaluate((element) =>
				element.scrollIntoView({ block: "start" }),
			);
			await world.page.evaluate(() =>
				(document.activeElement as HTMLElement | null)?.blur(),
			);
		},
	},
	{
		name: "assert the project cleanup modes",
		match:
			/^the project cleanup mode is "([^"]+)" and offers Use global, Off and Custom$/,
		run: async ({ world, match }) => {
			const select = cleanupGroup(world.page).getByTestId(
				"settings-cleanup-mode",
			);
			await expect(select.locator("option")).toHaveText([
				"Use global",
				"Off",
				"Custom",
			]);
			await expect(select.locator("option:checked")).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "choose the project cleanup mode",
		match: /^I set the project cleanup mode to "(Use global|Off|Custom)"$/,
		run: async ({ world, match }) => {
			await cleanupGroup(world.page)
				.getByTestId("settings-cleanup-mode")
				.selectOption({ label: match[1] ?? "" });
		},
	},
	{
		name: "assert inherited or seeded cleanup values",
		match: /^the cleanup values match global rules and are (disabled|enabled)$/,
		run: async ({ world, match }) => {
			const rules = requireRpcControl(world.page).worktreeCleanupGlobal;
			for (const [id, value] of [
				["on-settle", rules.onSettle],
				["settled-after", String(rules.settledAfterDays ?? "never")],
				["on-delete", rules.onDelete ? "remove" : "ask"],
				["keep-when", rules.keepWhen],
			]) {
				const select = cleanupGroup(world.page).getByTestId(
					`settings-cleanup-${id}`,
				);
				await expect(select).toHaveValue(value ?? "");
				await (match[1] === "disabled"
					? expect(select).toBeDisabled()
					: expect(select).toBeEnabled());
			}
		},
	},
	{
		name: "assert the saved project cleanup mode",
		match: /^the project cleanup override is saved as (global|off|custom)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const override =
				match[1] === "global"
					? null
					: match[1] === "off"
						? "off"
						: rpc.worktreeCleanupGlobal;
			const request = await rpc.waitForRequest(
				({ tag, payload }) =>
					tag === "SetWorktreeCleanupSetting" &&
					payload["scope"] === "project" &&
					(match[1] === "custom"
						? typeof payload["override"] === "object" &&
							payload["override"] !== null
						: payload["override"] === override),
			);
			expect(request.payload).toEqual({
				_tag: "SetWorktreeCleanupSetting",
				scope: "project",
				projectSlug: "myapp",
				override,
			});
		},
	},
	{
		name: "assert the saved custom cleanup rules",
		match:
			/^the project cleanup override saves settle (keep|nothing-missing) and settled age (never|\d+)$/,
		run: async ({ world, match }) => {
			const rpc = requireRpcControl(world.page);
			const override = {
				...rpc.worktreeCleanupGlobal,
				onSettle: match[1],
				settledAfterDays: match[2] === "never" ? null : Number(match[2]),
			};
			const request = await rpc.waitForRequest(
				({ tag, payload }) =>
					tag === "SetWorktreeCleanupSetting" &&
					payload["scope"] === "project" &&
					(payload["override"] as { onSettle?: unknown } | null)?.onSettle ===
						override.onSettle &&
					(payload["override"] as { settledAfterDays?: unknown } | null)
						?.settledAfterDays === override.settledAfterDays,
			);
			expect(request.payload).toEqual({
				_tag: "SetWorktreeCleanupSetting",
				scope: "project",
				projectSlug: "myapp",
				override,
			});
			await expect
				.poll(() => rpc.worktreeCleanupProjects.get("myapp"))
				.toEqual(override);
		},
	},
	{
		name: "assert project cleanup is off",
		match: /^project cleanup says "([^"]+)" without rule controls$/,
		run: async ({ world, match }) => {
			const group = cleanupGroup(world.page);
			await expect(group.getByTestId("settings-cleanup-off")).toHaveText(
				match[1] ?? "",
			);
			for (const id of ["on-settle", "settled-after", "on-delete", "keep-when"])
				await expect(group.getByTestId(`settings-cleanup-${id}`)).toHaveCount(
					0,
				);
			await expect(group.getByTestId("settings-cleanup-run")).toHaveCount(1);
		},
	},
	{
		name: "seed cleanup rules",
		match:
			/^worktree cleanup starts with settle (keep|nothing-missing), settled age (never|\d+) and delete (true|false)$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).worktreeCleanupGlobal = {
				...DEFAULT_WORKTREE_CLEANUP,
				onSettle: match[1] === "keep" ? "keep" : "nothing-missing",
				settledAfterDays: match[2] === "never" ? null : Number(match[2]),
				onDelete: match[3] === "true",
			};
		},
	},
	{
		name: "assert the global cleanup rows",
		match: /^worktree cleanup offers only the settle-driven rows$/,
		run: async ({ world }) => {
			const group = cleanupGroup(world.page);
			await expect(group.locator("label > span:first-child")).toHaveText([
				"Apply to",
				"When a session settles",
				"Remove settled worktrees after",
				"When a session is deleted",
				"Keep worktrees with",
			]);
			for (const label of [
				"Remove idle worktrees after",
				"Remove once merged",
				"Remove if its branch has no new commits",
			]) {
				await expect(group.getByText(label, { exact: true })).toHaveCount(0);
			}
		},
	},
	{
		name: "assert the settle options",
		match: /^the settle rule offers "([^"]+)" and "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				cleanupGroup(world.page)
					.getByTestId("settings-cleanup-on-settle")
					.locator("option"),
			).toHaveText([match[1] ?? "", match[2] ?? ""]);
		},
	},
	{
		name: "assert cleanup rule help",
		match: /^the (settle|settled age) rule explains "([^"]+)"$/,
		run: async ({ world, match }) => {
			const id = match[1] === "settle" ? "on-settle" : "settled-after";
			await expect(
				cleanupGroup(world.page).locator(`label[for="settings-cleanup-${id}"]`),
			).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert settled age presets",
		match: /^the settled age presets are (.+)$/,
		run: async ({ world, match }) => {
			const select = cleanupGroup(world.page).getByTestId(
				"settings-cleanup-settled-after",
			);
			await expect(select.locator("option")).toHaveText(
				(match[1] ?? "").split(", "),
			);
			// Frame the rule rows for the visual baseline that follows.
			await select.scrollIntoViewIfNeeded();
		},
	},
	{
		name: "assert idle settling precedes cleanup",
		match: /^Settle idle sessions after appears above Worktree cleanup$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByRole("combobox", {
					name: "Settle idle sessions after",
				}),
			).toBeVisible();
			expect(
				await world.page
					.getByTestId("settings-auto-settle-select")
					.evaluate((element) => {
						const cleanup = document.querySelector(
							"#settings-worktree-cleanup",
						);
						return (
							cleanup !== null &&
							Boolean(
								element.compareDocumentPosition(cleanup) &
									Node.DOCUMENT_POSITION_FOLLOWING,
							)
						);
					}),
			).toBe(true);
		},
	},
	{
		name: "choose a settle-driven rule",
		match: /^I set the (settle|settled age) rule to "([^"]+)"$/,
		run: async ({ world, match }) => {
			const id = match[1] === "settle" ? "on-settle" : "settled-after";
			await cleanupGroup(world.page)
				.getByTestId(`settings-cleanup-${id}`)
				.selectOption({ label: match[2] ?? "" });
		},
	},
	{
		name: "assert saved settle action",
		match:
			/^the worktree cleanup settle rule is saved as (keep|nothing-missing)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "SetWorktreeCleanupSetting" &&
					(payload["rules"] as { onSettle?: unknown } | undefined)?.onSettle ===
						match[1],
			);
		},
	},
	{
		name: "assert saved settled age",
		match: /^the worktree cleanup settled age is saved as (never|\d+)$/,
		run: async ({ world, match }) => {
			await requireRpcControl(world.page).waitForRequest(
				({ tag, payload }) =>
					tag === "SetWorktreeCleanupSetting" &&
					(payload["rules"] as { settledAfterDays?: unknown } | undefined)
						?.settledAfterDays ===
						(match[1] === "never" ? null : Number(match[1])),
			);
		},
	},
	{
		name: "assert the settled age selection",
		match: /^the settled age rule is set to "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				cleanupGroup(world.page)
					.getByTestId("settings-cleanup-settled-after")
					.locator("option:checked"),
			).toHaveText(match[1] ?? "");
		},
	},
	{
		name: "assert cleanup rule summary",
		match: /^the worktree cleanup summary reads "([^"]+)"$/,
		run: async ({ world, match }) => {
			await expect(
				cleanupGroup(world.page)
					.getByRole("button", { name: /^Worktree cleanup/ })
					.locator("span")
					.last(),
			).toHaveText(match[1] ?? "");
		},
	},
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
			requireRpcControl(world.page).setResponse("CleanUpWorktreesNow", {
				removed: [entry("row-opencode", "/worktrees/opencode", match[1] ?? "")],
				kept: [entry("row-kept", match[2] ?? "", match[3] ?? "")],
				failed: [entry("row-failed", match[4] ?? "", match[5] ?? "")],
			});
		},
	},
	{
		name: "seed the delete rule",
		match:
			/^worktree cleanup (asks about|removes) worktrees of deleted sessions$/,
		run: ({ world, match }) => {
			requireRpcControl(world.page).worktreeCleanupGlobal = {
				...DEFAULT_WORKTREE_CLEANUP,
				onDelete: match[1] === "removes",
			};
		},
	},
	{
		name: "hold cleanup until the server fails it",
		match: /^cleaning up now waits for the server$/,
		run: ({ world }) => {
			requireRpcControl(world.page).setHandler(
				"CleanUpWorktreesNow",
				() =>
					new Promise((_, reject) =>
						heldCleanups.set(world.page, () =>
							reject(new WsRpcError({ message: "Cleanup failed" })),
						),
					),
			);
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
					(payload["rules"] as { keepWhen?: unknown } | undefined)?.keepWhen ===
						match[1],
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
					(payload["rules"] as { onDelete?: unknown } | undefined)?.onDelete ===
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
