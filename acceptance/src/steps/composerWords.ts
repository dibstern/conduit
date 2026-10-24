import { expect } from "@playwright/test";
import { closeSettings } from "../../../test/e2e/helpers/settings.js";
import type { StepHandler } from "../runtime.js";
import { seedComposerPickerCatalog } from "./composerPicker.js";
import { requireRpcControl } from "./shared.js";

export const composerWordsHandlers: StepHandler[] = [
	{
		name: "assert branch-only Words checkout and accessible project",
		match:
			/^the Words checkout shows (.+) with a (worktree|branch|commit|folder) icon and names (.+)$/,
		run: async ({ world, match }) => {
			const checkout = world.page.getByTestId("composer-checkout");
			await expect(checkout).toBeVisible();
			if (match[2] === "folder") {
				await expect(checkout.locator('[data-part="project"]')).toHaveText(
					match[3] ?? "",
				);
				await expect(checkout.locator('[data-part="branch"]')).toHaveCount(0);
			} else {
				await expect(checkout.locator('[data-part="project"]')).toHaveCount(0);
				await expect(checkout.locator('[data-part="branch"]')).toHaveText(
					match[1] ?? "",
				);
			}
			await expect(
				checkout.locator(`[data-icon="${match[2]}"] svg`),
			).toBeVisible();
			expect(await checkout.getAttribute("aria-label")).toContain(
				match[3] ?? "",
			);
			if (match[2] !== "folder")
				expect(await checkout.getAttribute("aria-label")).toContain(
					match[1] ?? "",
				);
		},
	},
	{
		name: "assert Words checkout branch truncation",
		match:
			/^the Words checkout truncates its branch and retains its full identity$/,
		run: async ({ world }) => {
			const checkout = world.page.getByTestId("composer-checkout");
			await expect(checkout.locator('[data-part="project"]')).toHaveCount(0);
			await expect
				.poll(() =>
					checkout
						.locator('[data-part="branch"]')
						.evaluate((element) => element.scrollWidth > element.clientWidth),
				)
				.toBe(true);
			expect(await checkout.getAttribute("aria-label")).toContain(
				"conduit-worktrees",
			);
			expect(await checkout.getAttribute("aria-label")).toContain(
				"feature/session-account-chip-redesign",
			);
		},
	},

	{
		name: "assert phone Words summary",
		match: /^the phone Words summary reads (.+), (\w+), (\w+) and (\w+)$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("composer-words-row");
			const trigger = row.getByTestId("composer-words-sheet-trigger");
			await expect(trigger).toBeVisible();
			await expect(row.locator("button")).toHaveCount(1);
			for (const label of match.slice(1))
				await expect(trigger).toContainText(label);
			await expect(trigger.locator("button, a, input")).toHaveCount(0);
			await expect(trigger.getByTestId("harness-logo")).toBeVisible();
			await expect
				.poll(() =>
					row.evaluate((element) => {
						const trigger = element.querySelector(
							'[data-testid="composer-words-sheet-trigger"]',
						);
						if (!trigger) return false;
						const bounds = element.getBoundingClientRect(),
							button = trigger.getBoundingClientRect(),
							css = getComputedStyle(element);
						return (
							button.width >=
							bounds.width -
								parseFloat(css.paddingLeft) -
								parseFloat(css.paddingRight) -
								1
						);
					}),
				)
				.toBe(true);
			await expect(row.getByTestId("composer-checkout")).toHaveCount(0);
		},
	},
	{
		name: "assert phone Words summary focus",
		match: /^the phone Words summary is focused$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("composer-words-sheet-trigger"),
			).toBeFocused();
		},
	},
	{
		name: "assert phone Words mode and tone",
		match:
			/^the phone Words mode is (never|plan|ask|edits|auto|full) with the (never|plan|ask|edits|auto|full) tone$/,
		run: async ({ world, match }) => {
			const mode = world.page
				.getByTestId("composer-words-sheet-trigger")
				.getByText(match[1] ?? "", { exact: true });
			await expect(mode).toBeVisible();
			await expect
				.poll(() =>
					mode.evaluate((element, mode) => {
						const probe = document.createElement("span");
						probe.style.color = `var(--color-p-${mode})`;
						element.append(probe);
						const expected = getComputedStyle(probe).color;
						probe.remove();
						return getComputedStyle(element).color === expected;
					}, match[2] ?? "ask"),
				)
				.toBe(true);
		},
	},
	{
		name: "assert phone Words omits checkout",
		match: /^the phone Words row has no checkout$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.getByTestId("composer-words-row")
					.getByTestId("composer-checkout"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert phone Words context usage",
		match: /^the phone Words row omits checkout and shows (\d+)% context$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("composer-words-row");
			await expect(row.getByTestId("composer-checkout")).toHaveCount(0);
			await expect(row.getByTestId("composer-word-context-usage")).toHaveText(
				`${match[1]}%`,
			);
		},
	},

	{
		name: "open settings to general section",
		match: /^I open settings to the General section$/,
		run: async ({ world }) => {
			await world.page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { section: "general" } }),
				),
			);
			await expect(world.page.locator("#settings-panel")).toBeVisible();
			await expect(
				world.page.getByTestId("settings-composer-controls-icons"),
			).toHaveAttribute("aria-checked", "true");
		},
	},
	{
		name: "choose Words composer controls",
		match: /^I choose Words for composer controls$/,
		run: async ({ world }) => {
			const words = world.page.getByTestId("settings-composer-controls-words");
			await words.click();
			await expect(words).toHaveAttribute("aria-checked", "true");
			await expect
				.poll(() =>
					world.page.evaluate(() => {
						const stored = localStorage.getItem("conduit-composer-preferences");
						return stored
							? (JSON.parse(stored) as { controls?: unknown }).controls
							: null;
					}),
				)
				.toBe("words");
			await closeSettings(world.page);
			await expect(world.page.locator("#settings-panel")).toBeHidden();
		},
	},
	{
		name: "reload Words composer with its mock session and catalog",
		match: /^I reload the Words composer$/,
		run: async ({ world }) => {
			const rpc = requireRpcControl(world.page);
			const previousRequests = rpc.getRequests().length;
			await world.page.reload();
			await expect(world.page.locator("#connect-overlay")).toBeHidden();
			await expect(world.page.locator("#input")).toBeVisible();
			await expect
				.poll(() => {
					const requests = rpc.getRequests().slice(previousRequests);
					return ["ViewSession", "GetModels"].every((tag) =>
						requests.some((request) => request.tag === tag),
					);
				})
				.toBe(true);
			await seedComposerPickerCatalog(world.page, "Claude");
		},
	},
	{
		name: "assert composer Words controls",
		match:
			/^the composer words row shows (.+), (\w+|no window), (\w+) and (\w+)$/,
		run: async ({ world, match }) => {
			const row = world.page
				.locator("#input-area")
				.getByTestId("composer-words-row");
			await expect(row).toBeVisible();
			for (const [id, label] of [
				["composer-word-model", match[1]],
				["composer-word-context", match[2]],
				["composer-word-effort", match[3]],
				["composer-word-approvals", match[4]],
			] as const) {
				const control = row.getByTestId(id);
				if (label === "no window") {
					await expect(control).toHaveCount(0);
					continue;
				}
				await expect(control).toHaveText(label ?? "");
				await expect(control).toHaveJSProperty("tagName", "BUTTON");
				await expect(control).not.toHaveAttribute("aria-busy", "true");
				await expect(control.locator("svg")).toHaveCount(0);
			}
		},
	},
	{
		name: "assert wide-only account word",
		match: /^the composer account word is (.+)$/,
		run: async ({ world, match }) => {
			const word = world.page.getByTestId("composer-word-account");
			if (match[1] === "absent") await expect(word).toHaveCount(0);
			else {
				await expect(word).toHaveText(match[1] ?? "");
				await expect(word).toHaveJSProperty("tagName", "BUTTON");
			}
		},
	},
	{
		name: "assert words groups and rightmost context usage",
		match:
			/^the words row keeps what on the left and checkout then (\d+)% on the right$/,
		run: async ({ world, match }) => {
			const row = world.page.getByTestId("composer-words-row");
			const left = row.getByTestId("composer-words-left");
			const right = row.getByTestId("composer-words-right");
			await expect(
				left.getByTestId("composer-word-harness").getByTestId("harness-logo"),
			).toHaveCSS("width", "15px");
			const order = await left.evaluate((element) =>
				Array.from(
					element.querySelectorAll('[data-testid^="composer-word-"]'),
				).map((control) => control.getAttribute("data-testid")),
			);
			const expected = ["composer-word-harness"];
			if (await left.getByTestId("composer-word-account").count())
				expected.push("composer-word-account");
			expected.push("composer-word-model");
			if (await left.getByTestId("composer-word-context").count())
				expected.push("composer-word-context");
			expected.push("composer-word-effort", "composer-word-approvals");
			expect(order).toEqual(expected);
			await expect(right.getByTestId("composer-checkout")).toBeVisible();
			const usage = right.getByTestId("composer-word-context-usage");
			await expect(usage).toHaveText(`${match[1]}%`);
			const fits = await row.evaluate((element) => {
				const leftGroup = element.querySelector(
					'[data-testid="composer-words-left"]',
				);
				const checkout = element.querySelector(
					'[data-testid="composer-checkout"]',
				);
				const percent = element.querySelector(
					'[data-testid="composer-word-context-usage"]',
				);
				if (!leftGroup || !checkout || !percent) return false;
				const leftBox = leftGroup.getBoundingClientRect();
				const checkoutBox = checkout.getBoundingClientRect();
				const usageBox = percent.getBoundingClientRect();
				const rowBox = element.getBoundingClientRect();
				return (
					leftBox.right <= checkoutBox.left &&
					checkoutBox.right <= usageBox.left &&
					usageBox.right <= rowBox.right
				);
			});
			expect(fits).toBe(true);
		},
	},
	{
		name: "assert checkout identity and icon kind in the composer",
		match:
			/^the composer checkout shows (?:(?:(.+) \/ )?(.+) with a|just a) (worktree|branch|commit|folder) icon$/,
		run: async ({ world, match }) => {
			const checkout = world.page.getByTestId("composer-checkout");
			await expect(checkout).toBeVisible();
			// The words row names only the branch; the project stays in its menu.
			const project = checkout.locator('[data-part="project"]');
			if (match[1]) await expect(project).toHaveText(match[1]);
			else await expect(project).toHaveCount(0);
			// "just a" is the collapsed checkout: the icon without labels.
			const branch = checkout.locator('[data-part="branch"]');
			if (match[3] === "folder" || !match[2])
				await expect(branch).toHaveCount(0);
			else await expect(branch).toHaveText(match[2]);
			await expect(
				checkout.locator(`[data-icon="${match[3]}"] svg`),
			).toBeVisible();
		},
	},
	{
		name: "assert the checkout project yields room before the branch",
		match: /^the composer checkout truncates the project before the branch$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					world.page.getByTestId("composer-checkout").evaluate((element) => {
						const project = element.querySelector<HTMLElement>(
							'[data-part="project"]',
						);
						const branch = element.querySelector<HTMLElement>(
							'[data-part="branch"]',
						);
						if (!project || !branch) return false;
						const projectStyle = getComputedStyle(project);
						const branchStyle = getComputedStyle(branch);
						const projectWidth = project.getBoundingClientRect().width;
						const branchWidth = branch.getBoundingClientRect().width;
						const projectFloor = Number.parseFloat(projectStyle.minWidth);
						const branchFloor = Number.parseFloat(branchStyle.minWidth);
						return (
							project.scrollWidth > project.clientWidth &&
							Number(projectStyle.flexShrink) >
								Number(branchStyle.flexShrink) &&
							projectWidth >= projectFloor - 1 &&
							branchWidth >= branchFloor - 1 &&
							(branch.scrollWidth <= branch.clientWidth ||
								projectWidth <= projectFloor + 1)
						);
					}),
				)
				.toBe(true);
		},
	},
	{
		name: "open composer checkout menu",
		match: /^I open the composer checkout menu$/,
		run: async ({ world }) => {
			await world.page.getByTestId("composer-checkout").click();
			await expect(
				world.page.getByTestId("composer-checkout-menu"),
			).toBeVisible();
		},
	},
	{
		name: "assert checkout menu retains full names",
		match: /^the composer checkout menu shows (.+) and (.+) in full$/,
		run: async ({ world, match }) => {
			const menu = world.page.getByTestId("composer-checkout-menu");
			await expect(menu).toContainText(`/workspace/${match[1]}`);
			await expect(menu).toContainText(match[2] ?? "");
		},
	},
	{
		name: "assert git attention marks at each composer tier",
		match:
			/^the composer checkout shows uncommitted, rebasing and (visible|hidden) upstream counts$/,
		run: async ({ world, match }) => {
			const checkout = world.page.getByTestId("composer-checkout");
			const dirty = checkout.locator('[data-part="dirty"]');
			await expect(dirty).toBeVisible();
			await expect(dirty).toHaveCSS("width", "6px");
			await expect(dirty).toHaveCSS("height", "6px");
			await expect(dirty).toContainText("Uncommitted changes");
			await expect(checkout.locator('[data-part="operation"]')).toHaveText(
				"rebasing",
			);
			const upstream = checkout.locator('[data-part="upstream"]');
			if (match[1] === "visible") await expect(upstream).toHaveText("↑2 ↓1");
			else await expect(upstream).toHaveCount(0);
		},
	},
	{
		name: "assert upstream and changes remain in checkout details on phones",
		match:
			/^the composer checkout menu shows uncommitted changes and upstream 2 ahead and 1 behind$/,
		run: async ({ world }) => {
			const menu = world.page.getByTestId("composer-checkout-menu");
			await expect(menu.getByTestId("checkout-ahead")).toHaveText("2ahead");
			await expect(menu.getByTestId("checkout-behind")).toHaveText("1behind");
			await expect(menu.getByTestId("checkout-changes")).toHaveText(
				"3+12-4files changed",
			);
			await expect(
				menu.getByRole("menuitem", { name: "Copy worktree path" }),
			).toContainText("Worktree");
			await expect(
				menu.getByRole("menuitem", { name: "Copy commit hash" }),
			).toContainText("6b11104");
		},
	},
	{
		name: "copy a checkout value without closing the menu",
		match: /^I tap the checkout (Branch copy control|HEAD row)$/,
		run: async ({ world, match }) => {
			await world.page
				.context()
				.grantPermissions(["clipboard-read", "clipboard-write"]);
			const menu = world.page.getByTestId("composer-checkout-menu");
			const control =
				match[1] === "HEAD row"
					? menu.getByRole("menuitem", { name: "Copy commit hash" })
					: menu.getByRole("menuitem", { name: "Copy branch name" });
			await control.click();
			await expect(menu).toBeVisible();
		},
	},
	{
		name: "assert a checkout copy toast and system clipboard",
		match:
			/^the checkout shows (Branch copied|Commit hash copied) and the clipboard contains (.+)$/,
		run: async ({ world, match }) => {
			const toast = world.page
				.locator('[data-testid="toast"], [data-testid="session-sheet-toast"]')
				.filter({ hasText: match[1] ?? "" });
			await expect(toast).toBeVisible();
			await expect(toast).toHaveAttribute("data-variant", "success");
			await expect(toast.locator("svg").first()).toBeVisible();
			await expect
				.poll(() => world.page.evaluate(() => navigator.clipboard.readText()))
				.toBe(match[2]);
		},
	},
	{
		name: "assert workspace warning is an icon and actions stay in the menu",
		match:
			/^the composer checkout has a workspace (hint|mismatch) icon without inline actions$/,
		run: async ({ world, match }) => {
			const warning = world.page
				.getByTestId("composer-checkout")
				.getByTestId(
					match[1] === "hint"
						? "workspace-hint"
						: "workspace-mismatch-indicator",
				);
			await expect(warning).toBeVisible();
			await expect(warning).toHaveText("");
			await expect(warning).toHaveAttribute("aria-label", /.+/);
			await expect(warning.locator("svg")).toBeVisible();
			await expect(world.page.getByTestId("workspace-hint-move")).toHaveCount(
				0,
			);
			await expect(
				world.page.getByTestId("workspace-hint-dismiss"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert composer checkout menu workspace hint and actions",
		match: /^the composer checkout menu offers Move and Dismiss for (.+)$/,
		run: async ({ world, match }) => {
			const menu = world.page.getByTestId("composer-checkout-menu");
			await expect(menu).toContainText(match[1] ?? "");
			await expect(menu.getByTestId("workspace-hint-move")).toBeVisible();
			await expect(menu.getByTestId("workspace-hint-dismiss")).toBeVisible();
		},
	},
	{
		name: "assert composer checkout menu workspace mismatch and retry",
		match: /^the composer checkout menu reports (.+) and offers Retry move$/,
		run: async ({ world, match }) => {
			const menu = world.page.getByTestId("composer-checkout-menu");
			await expect(menu.getByTestId("workspace-mismatch")).toContainText(
				match[1] ?? "",
			);
			await expect(
				menu.getByRole("menuitem", { name: "Retry move", exact: true }),
			).toBeVisible();
		},
	},
	{
		name: "select composer checkout workspace action",
		match: /^I choose (Move|Dismiss|Retry move) in the composer checkout menu$/,
		run: async ({ world, match }) => {
			await world.page
				.getByTestId("composer-checkout-menu")
				.getByRole("menuitem", { name: match[1] ?? "", exact: true })
				.click();
		},
	},
	{
		name: "assert checkout workspace action targets the current session and path",
		match: /^the checkout (Move|Dismiss|Retry move) RPC targets (.+)$/,
		run: async ({ world, match }) => {
			const tag =
				match[1] === "Dismiss"
					? "DismissWorkspaceHint"
					: "MoveSessionWorkspace";
			const request = await requireRpcControl(world.page).waitForRequest(
				(candidate) => candidate.tag === tag,
			);
			expect(request.payload).toMatchObject({
				sessionId: new URL(world.page.url()).pathname.split("/")[2],
				path: match[2],
			});
		},
	},
	{
		name: "tap a composer word",
		match: /^I tap the (badge|account|model|window|agent) word$/,
		run: async ({ world, match }) => {
			const word =
				match[1] === "badge"
					? "harness"
					: match[1] === "window"
						? "context"
						: match[1];
			await world.page.getByTestId(`composer-word-${word}`).click();
		},
	},
	{
		name: "assert a word opens its picker section",
		match: /^the word opens the picker at (Account|Model|Effort|Agent)$/,
		run: async ({ world, match }) => {
			const picker = world.page.getByTestId("model-picker");
			await expect(picker).toBeVisible();
			if (match[1] === "Model") {
				await expect(picker.getByTestId("model-picker-list")).toBeVisible();
				await expect(picker.getByTestId("picker-back")).toBeVisible();
			} else if (match[1] === "Agent") {
				await expect(picker.getByTestId("picker-agent-build")).toBeVisible();
			} else if (match[1] === "Account") {
				await expect
					.poll(() =>
						picker
							.getByTestId("picker-account-section")
							.evaluate((section) => section.contains(document.activeElement)),
					)
					.toBe(true);
			} else {
				await expect(picker.getByTestId("picker-row-effort")).toBeFocused();
			}
		},
	},
	{
		name: "assert words use OpenCode agent instead of approvals",
		match: /^the composer agent word is (.+) and replaces approvals$/,
		run: async ({ world, match }) => {
			await expect(world.page.getByTestId("composer-word-agent")).toHaveText(
				match[1] ?? "",
			);
			await expect(
				world.page.getByTestId("composer-word-approvals"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert a draft has an empty words right group and keeps its context",
		match:
			/^the words draft has an empty right group and keeps context (above|below) the composer$/,
		run: async ({ world, match }) => {
			const area = world.page.locator("#input-area");
			await expect(area.getByTestId("composer-checkout")).toHaveCount(0);
			const right = area.getByTestId("composer-words-right");
			await expect(right).toHaveText("");
			await expect(right.locator("button")).toHaveCount(0);
			const context = world.page.getByTestId("new-session-context");
			await expect(context).toBeVisible();
			await expect(context.getByTestId("draft-project-chip")).toContainText(
				"myapp",
			);
			const [contextBox, borderBox] = await Promise.all([
				context.boundingBox(),
				area.locator("#input-row").boundingBox(),
			]);
			if (!contextBox || !borderBox)
				throw new Error("Draft context or composer has no bounds");
			if (match[1] === "above")
				expect(contextBox.y + contextBox.height).toBeLessThanOrEqual(
					borderBox.y,
				);
			else
				expect(contextBox.y).toBeGreaterThanOrEqual(
					borderBox.y + borderBox.height,
				);
		},
	},
	{
		name: "assert zero context stays absent from the words row",
		match: /^the words row context usage is absent$/,
		run: async ({ world }) => {
			await expect(
				world.page.getByTestId("composer-word-context-usage"),
			).toHaveCount(0);
		},
	},
	{
		name: "assert composer icon controls are absent",
		match: /^the composer icon controls are absent$/,
		run: async ({ world }) => {
			await expect(
				world.page
					.locator("#input-area")
					.getByTestId(
						/^(composer-harness-trigger|model-picker-trigger|variant-badge|permission-mode-badge)$/,
					),
			).toHaveCount(0);
		},
	},
	{
		name: "assert Words row sits below the bordered composer",
		match: /^the words row is below the composer border$/,
		run: async ({ world }) => {
			await expect
				.poll(() =>
					world.page.locator("#input-area").evaluate((area) => {
						const border = area.querySelector("#input-row");
						const row = area.querySelector(
							'[data-testid="composer-words-row"]',
						);
						if (!border || !row || border.contains(row)) return false;
						const borderBox = border.getBoundingClientRect();
						const rowBox = row.getBoundingClientRect();
						const areaBox = area.getBoundingClientRect();
						return (
							rowBox.height > 0 &&
							rowBox.top >= borderBox.bottom &&
							rowBox.bottom <= areaBox.bottom &&
							rowBox.left >= areaBox.left &&
							rowBox.right <= areaBox.right
						);
					}),
				)
				.toBe(true);
		},
	},
];
