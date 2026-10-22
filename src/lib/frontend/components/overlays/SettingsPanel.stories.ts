import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_USAGE_LIMITS } from "../../../contracts/limit-recovery.js";
import {
	composerPreferences,
	setComposerPreferences,
} from "../../stores/composer-preferences.svelte.js";
import { cursorAuth } from "../../stores/cursor-auth.svelte.js";
import {
	clearDiscoveryState,
	handleAgentList,
	handleHarnessDefaults,
	handleModelList,
	handleVisibilityInfo,
} from "../../stores/discovery.svelte.js";
import { featureFlags } from "../../stores/feature-flags.svelte.js";
import {
	applyInstanceListResponse,
	getCachedInstances,
} from "../../stores/instance.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { serverStatus } from "../../stores/server-status.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import {
	applyUsageLimitsSetting,
	applyUsageReadings,
	usageState,
} from "../../stores/usage.svelte.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import { usageResetTime } from "../../utils/continuation.js";
import SettingsPanel from "./SettingsPanel.svelte";

function resetState() {
	setComposerPreferences({ controls: "icons", contextWarning: 80 });
	routerState.path = "/";
	clearDiscoveryState();
	applyInstanceListResponse({ instances: [] });
	Object.assign(serverStatus, {
		status: {
			uptime: 273_600,
			version: "0.42.1",
			port: 2633,
			host: "0.0.0.0",
			clientCount: 2,
			projectCount: 0,
			sessionCount: 0,
			pinEnabled: false,
			tlsEnabled: false,
			tailscaleServeEnabled: true,
			tailscaleServeAvailable: true,
			tailscaleServe: { url: "https://conduit.example.ts.net" },
			keepAwake: false,
			keepAwakeCommand: "caffeinate -di",
			logLevel: "info",
			supervised: true,
			projects: [],
		},
		loading: false,
		error: null,
		restartInFlight: false,
		restartAccepted: false,
		shutdownInFlight: false,
	});
	applyUsageReadings([]);
	applyUsageLimitsSetting(DEFAULT_USAGE_LIMITS);
	// GetCursorAuth is never answered in stories, so seed a settled logged-out reply.
	cursorAuth.current = {
		source: "none",
		status: "logged-out",
		expiresSoon: false,
		login: { state: "idle" },
	};
	featureFlags.debug = false;
	localStorage.setItem(
		"notif-settings",
		JSON.stringify({ push: false, browser: true, sound: false }),
	);
}

function populateInstances() {
	applyInstanceListResponse({
		instances: [
			{
				id: "claude",
				name: "Personal Claude",
				driver: "claude",
				isDefault: true,
				configDir: "~/.claude",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_800_000,
			},
			{
				id: "work-claude",
				name: "Work Claude",
				driver: "claude",
				configDir: "~/.config/claude/work",
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_860_000,
			},
			{
				id: "instance-local",
				name: "Local OpenCode",
				port: 4096,
				managed: true,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_800_000,
			},
			{
				id: "instance-discovered",
				name: "Team sandbox",
				port: 4102,
				managed: false,
				status: "stopped",
				restartCount: 0,
				createdAt: 1_772_011_860_000,
			},
		],
	});
}

const meta = {
	title: "Overlays/SettingsPanel",
	component: SettingsPanel,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "720px" } },
	},
	args: {
		visible: true,
		onClose: fn(),
	},
	beforeEach: () => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = window.innerWidth < 768;
		// Mount-time reads wait on an open socket instead of failing whenever the
		// real dial gives up; proxy detection settles at once as "not found".
		const restoreSocket = connectedSocket();
		const restoreDetectProxy = replyRpc("DetectProxy", () => ({
			found: false,
			port: 8317,
		}));
		resetState();
		return () => {
			sessionViewState.compact = compact;
			cursorAuth.current = undefined;
			restoreDetectProxy();
			restoreSocket();
		};
	},
} satisfies Meta<typeof SettingsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Scroll changes do not produce the DOM mutations the visual runner waits for. */
async function scrollSettingsIntoView(
	element: HTMLElement,
	block: ScrollLogicalPosition,
): Promise<void> {
	await element.ownerDocument.fonts.ready;
	const scroller = element.closest<HTMLElement>(".settings-content");
	await expect(scroller).not.toBeNull();
	if (!scroller) return;
	element.scrollIntoView({ block, behavior: "instant" });
	let previousTop = scroller.scrollTop;
	let stableFrames = 0;
	while (stableFrames < 2) {
		await new Promise<void>((resolve) =>
			requestAnimationFrame(() => resolve()),
		);
		const top = scroller.scrollTop;
		stableFrames = top === previousTop ? stableFrames + 1 : 0;
		previousTop = top;
	}
}

/** A generic open: General on desktop, the section list on phone. */
export const Default: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await expect(body.getByRole("dialog", { name: "Settings" })).toBeVisible();
		await expect(body.getByTestId("settings-close-btn")).toBeVisible();
		await canvasElement.ownerDocument.fonts.ready;
		const panel = body
			.getByRole("dialog")
			.querySelector<HTMLElement>("#settings-panel");
		await expect(panel).not.toBeNull();
		if (!panel) return;
		const header = panel.querySelector<HTMLElement>(".settings-header");
		await expect(header).not.toBeNull();
		if (!header) return;
		const dimmer = getComputedStyle(panel)
			.getPropertyValue("--color-text-dimmer")
			.trim();
		const swatch = canvasElement.ownerDocument.createElement("span");
		swatch.style.color = dimmer;
		panel.append(swatch);
		const secondaryColour = getComputedStyle(swatch).color;
		swatch.remove();
		if (sessionViewState.compact) {
			const leftInset = parseFloat(getComputedStyle(header).paddingLeft);
			const done = body
				.getByTestId("settings-close-btn")
				.getBoundingClientRect();
			await expect(leftInset).toBeGreaterThanOrEqual(14);
			await expect(
				Math.abs(header.getBoundingClientRect().right - done.right - leftInset),
			).toBeLessThanOrEqual(1);
			await expect(getComputedStyle(header).backgroundColor).toBe(
				canvasElement.ownerDocument.documentElement.classList.contains(
					"light-theme",
				)
					? "rgb(255, 255, 255)"
					: "rgb(17, 17, 19)",
			);
			const you = body.getByTestId("avatar-change-root");
			const rootGap =
				you.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
			await expect(you.getBoundingClientRect().height).toBeCloseTo(56.3, 1);
			await expect(
				body.getByTestId("settings-tab-general").getBoundingClientRect().top -
					you.getBoundingClientRect().bottom,
			).toBe(18);
			const chevron = you.querySelector("svg");
			await expect(chevron).not.toBeNull();
			if (chevron)
				await expect(getComputedStyle(chevron).color).toBe(
					canvasElement.ownerDocument.documentElement.classList.contains(
						"light-theme",
					)
						? "rgb(155, 155, 164)"
						: "rgb(107, 107, 116)",
				);
			const subtitle = body.getByText("Avatar, on every device");
			await expect(getComputedStyle(subtitle).fontSize).toBe("12px");
			await expect(getComputedStyle(subtitle).color).toBe(secondaryColour);
			const bounds = canvasElement.ownerDocument
				.getElementById("settings-panel")
				?.getBoundingClientRect();
			await expect(bounds?.x).toBeCloseTo(0, 0);
			await expect(bounds?.y).toBeCloseTo(0, 0);
			await expect(bounds?.width).toBe(window.innerWidth);
			await expect(bounds?.height).toBe(window.innerHeight);
			await expect(body.getByTestId("settings-close-btn")).toHaveTextContent(
				"Done",
			);
			await expect(
				getComputedStyle(body.getByTestId("settings-close-btn")).fontWeight,
			).toBe("600");
			await expect(
				body.queryByTestId("settings-back-btn"),
			).not.toBeInTheDocument();
			await userEvent.click(body.getByTestId("settings-tab-general"));
			const heading = body.getByRole("heading", {
				level: 2,
				name: "General",
			});
			await expect(heading).toBeVisible();
			const youSection = panel.querySelector<HTMLElement>("#settings-you");
			const appearance = panel.querySelector<HTMLElement>(
				"#settings-appearance",
			);
			await expect(youSection).not.toBeNull();
			await expect(appearance).not.toBeNull();
			if (!youSection || !appearance) return;
			const sectionGap =
				appearance.getBoundingClientRect().top -
				youSection.getBoundingClientRect().bottom;
			await expect(sectionGap).toBe(16);
			await expect(Math.abs(rootGap - sectionGap)).toBeLessThanOrEqual(1);
			await expect(
				Math.abs(
					youSection.getBoundingClientRect().top -
						header.getBoundingClientRect().bottom -
						sectionGap,
				),
			).toBeLessThanOrEqual(1);
			await expect(
				body.queryByTestId("settings-close-btn"),
			).not.toBeInTheDocument();
			const title = heading.getBoundingClientRect();
			await expect(title.x + title.width / 2).toBeCloseTo(
				window.innerWidth / 2,
				0,
			);
			await userEvent.click(body.getByTestId("settings-back-btn"));
			await expect(
				body.getByRole("heading", { level: 2, name: "Settings" }),
			).toBeVisible();
			await waitFor(() =>
				expect(body.getByTestId("settings-tab-general")).toHaveFocus(),
			);
		} else {
			const close = body.getByTestId("settings-close-btn");
			await expect(close.getBoundingClientRect().width).toBe(32);
			await expect(close.getBoundingClientRect().height).toBe(32);
			await expect(
				close.querySelector("svg")?.getBoundingClientRect().width,
			).toBe(13);
			await expect(getComputedStyle(close).borderRadius).toBe("50%");
			await expect(getComputedStyle(close).backgroundColor).not.toBe(
				"rgba(0, 0, 0, 0)",
			);
			const label = body.getByRole("heading", { level: 3, name: "Appearance" });
			await expect(label.getBoundingClientRect().height).toBe(18);
			await expect(
				body
					.getByRole("heading", { level: 3, name: "Notifications" })
					.getBoundingClientRect().top - panel.getBoundingClientRect().top,
			).toBeCloseTo(431.59, 1);
			await expect(getComputedStyle(label).color).toBe(secondaryColour);
			await expect(
				getComputedStyle(
					body.getByText("Next to your messages, on every device"),
				).color,
			).toBe(secondaryColour);
			await expect(
				getComputedStyle(body.getByTestId("tabs-group-label")).color,
			).toBe(secondaryColour);
			const mark = body.getByTestId("settings-tab-claude").querySelector("g");
			await expect(mark).not.toBeNull();
			if (!mark) return;
			await expect(getComputedStyle(mark).fill).toBe(
				canvasElement.ownerDocument.documentElement.classList.contains(
					"light-theme",
				)
					? "rgb(155, 155, 164)"
					: "rgb(107, 107, 116)",
			);
			const change = body.getByTestId("avatar-change");
			await expect(change.getBoundingClientRect().height).toBe(28);
			await expect(getComputedStyle(change).borderTopWidth).toBe("0px");
			await expect(body.getByRole("tablist")).toHaveAttribute(
				"aria-orientation",
				"vertical",
			);
			await expect(body.getByTestId("settings-tab-general")).toHaveAttribute(
				"aria-selected",
				"true",
			);
			await userEvent.click(body.getByTestId("settings-tab-models"));
			await expect(
				body.getByRole("heading", {
					level: 2,
					name: "Models & agents",
				}),
			).toBeVisible();
			await userEvent.click(body.getByTestId("settings-tab-general"));
			await expect(
				body.getByRole("heading", { level: 2, name: "General" }),
			).toBeVisible();
		}
		(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
	},
};

export const DefaultLight: Story = { ...Default, globals: { theme: "light" } };

/** An explicit General open: on phone it lands drilled in, past the list. */
export const NotificationsEnabled: Story = {
	args: { initialTab: "general" },
	beforeEach: () => {
		localStorage.setItem(
			"notif-settings",
			JSON.stringify({ push: true, browser: true, sound: true }),
		);
	},
};

export const Composer: Story = {
	tags: ["autodocs"],
	args: { initialTab: "general" },
	globals: { theme: "dark" },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			body
				.getAllByRole("heading", { level: 3 })
				.map((heading) => heading.textContent),
		).toEqual(["You", "Appearance", "Composer", "Notifications", "Sessions"]);
		await expect(
			body.getByRole("button", { name: /^Advanced.*Debug off$/ }),
		).toHaveAttribute("aria-expanded", "false");
		// On phone an explicit section opens drilled in, so the list is not shown.
		const tab = body.queryByTestId("settings-tab-general");
		if (tab) await expect(tab).toHaveAttribute("aria-selected", "true");
		else await expect(body.getByTestId("settings-back-btn")).toBeVisible();
		const icons = body.getByRole("radio", { name: "Icons" });
		const words = body.getByRole("radio", { name: "Words" });
		await expect(icons).toHaveAttribute("aria-checked", "true");
		await userEvent.click(words);
		await expect(words).toHaveAttribute("aria-checked", "true");
		await expect(composerPreferences.controls).toBe("words");
		await expect(
			JSON.parse(localStorage.getItem("conduit-composer-preferences") ?? "{}"),
		).toEqual({ controls: "words", contextWarning: 80 });
		await userEvent.click(icons);
		await expect(icons).toHaveAttribute("aria-checked", "true");
		await expect(composerPreferences.controls).toBe("icons");
		const warning = body.getByTestId("settings-composer-context-warning");
		await expect(warning).toHaveAttribute("data-value", "80");
		for (const threshold of [60, 70, 80, 90, "never"] as const) {
			await userEvent.click(warning);
			const option = body.getByTestId(
				`settings-composer-context-warning-${threshold}`,
			);
			await userEvent.click(option);
			await expect(warning).toHaveAttribute("data-value", String(threshold));
			await expect(composerPreferences.contextWarning).toBe(threshold);
		}
		await expect(
			JSON.parse(localStorage.getItem("conduit-composer-preferences") ?? "{}"),
		).toEqual({ controls: "icons", contextWarning: "never" });
		await userEvent.click(warning);
		await userEvent.click(
			body.getByTestId("settings-composer-context-warning-80"),
		);
		// userEvent focus reads as keyboard focus; keep its ring out of the baseline.
		(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
	},
};

export const ComposerLight: Story = {
	...Composer,
	tags: ["autodocs"],
	globals: { theme: "light" },
};

export const Advanced: Story = {
	args: { initialTab: "general" },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const disclosure = body.getByRole("button", {
			name: /^Advanced.*Debug off$/,
		});
		await expect(disclosure).toHaveAttribute("aria-expanded", "false");
		await scrollSettingsIntoView(disclosure, "nearest");
		await userEvent.click(disclosure);
		const toggle = body.getByRole("switch", {
			name: "Toggle connection debug panel",
		});
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await userEvent.click(toggle);
		await expect(disclosure).toHaveTextContent("Debug on");
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		await scrollSettingsIntoView(toggle, "nearest");
		(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
	},
};

/** Worktree cleanup expanded at its defaults, which warn that ignored files are lost. */
export const WorktreeCleanup: Story = {
	args: { initialTab: "general" },
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		const disclosure = body.getByRole("button", {
			name: /^Worktree cleanup.*When nothing is missing$/,
		});
		await userEvent.click(disclosure);
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		await scrollSettingsIntoView(disclosure, "start");
		await expect(
			body.getByTestId("settings-cleanup-on-settle"),
		).toHaveAttribute("data-value", "nothing-missing");
		await expect(
			body.getByTestId("settings-cleanup-settled-after"),
		).toHaveAttribute("data-value", "never");
		await expect(
			body.getByTestId("settings-cleanup-keep-when"),
		).toHaveAttribute("data-value", "uncommitted-changes");
		await expect(
			body.getByTestId("settings-cleanup-keep-warning"),
		).toHaveTextContent(/^Ignored files, like \.env/);
		(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
	},
};

export const VisibilityEmpty: Story = {
	args: { initialTab: "models" },
};

function populateVisibility() {
	// Claude's catalog belongs to its default account, so the project default resolves against it.
	applyInstanceListResponse({
		instances: [
			{
				id: "claude",
				name: "Personal Claude",
				driver: "claude",
				isDefault: true,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_800_000,
			},
		],
	});
	handleModelList({
		providers: [
			{
				id: "claude",
				name: "Claude",
				configured: true,
				models: [
					{
						id: "opus",
						name: "Opus",
						provider: "claude",
						variants: ["high", "max"],
						contextWindowOptions: [
							{ value: "200k", label: "200k" },
							{ value: "1m", label: "1M" },
						],
					},
				],
			},
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4",
						name: "Claude Sonnet 4",
						provider: "anthropic",
					},
					{
						id: "claude-haiku-3-5",
						name: "Claude Haiku 3.5",
						provider: "anthropic",
					},
				],
			},
			{
				id: "openai",
				name: "OpenAI",
				configured: true,
				models: [
					{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
					{ id: "gpt-5", name: "GPT-5", provider: "openai" },
				],
			},
		],
	});
	handleHarnessDefaults({
		_tag: "harnessDefaults",
		claude: {
			status: "ok",
			pick: {
				providerId: "claude",
				modelId: "opus",
				effort: "max",
				contextWindow: "1m",
			},
		},
		opencode: {
			status: "ok",
			pick: {
				providerId: "anthropic",
				modelId: "claude-sonnet-4",
				effort: "",
				contextWindow: "",
			},
		},
	});
	handleVisibilityInfo({
		hiddenModels: ["anthropic/claude-haiku-3-5"],
		hiddenAgents: ["anthropic/review"],
	});
	handleAgentList({
		providerScope: { id: "anthropic", name: "Anthropic" },
		agents: [
			{
				id: "code",
				name: "Code",
				description: "Write and edit code",
			},
			{
				id: "review",
				name: "Review",
				description: "Review changes without editing",
			},
		],
	});
}

export const Models: Story = {
	args: { initialTab: "models" },
	beforeEach: populateVisibility,
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await expect(body.getByTestId("settings-models-summary")).toHaveTextContent(
			"4 of 5 shown",
		);
		for (const testId of [
			"settings-models-group-claude",
			"settings-models-group-anthropic",
			"settings-models-group-openai",
			"settings-agents-group",
		])
			await expect(
				within(body.getByTestId(testId)).getByRole("button", {
					expanded: false,
				}),
			).toBeVisible();
		await expect(body.queryAllByRole("switch")).toHaveLength(0);
	},
};

export const ModelsLight: Story = { ...Models, globals: { theme: "light" } };

export const ModelsInvalidDefault: Story = {
	args: { initialTab: "models" },
	beforeEach: () => {
		populateVisibility();
		handleHarnessDefaults({
			_tag: "harnessDefaults",
			claude: {
				status: "invalid",
				pick: {
					providerId: "claude",
					modelId: "retired-sonnet",
					effort: "",
					contextWindow: "",
				},
				problem:
					"ModelNotInCatalog: model claude/retired-sonnet is not in the claude catalog",
			},
			opencode: {
				status: "ok",
				pick: {
					providerId: "anthropic",
					modelId: "claude-sonnet-4",
					effort: "",
					contextWindow: "",
				},
			},
		});
	},
};

export const ModelsFiltered: Story = {
	...Models,
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.type(
			body.getByRole("searchbox", { name: "Filter models and agents" }),
			"4",
		);
		for (const provider of ["anthropic", "openai"])
			await expect(
				within(body.getByTestId(`settings-models-group-${provider}`)).getByRole(
					"button",
					{ expanded: true },
				),
			).toBeVisible();
		await expect(
			body.getByRole("switch", { name: "Toggle claude sonnet 4" }),
		).toBeVisible();
		await expect(
			body.getByRole("switch", { name: "Toggle gpt-4.1" }),
		).toBeVisible();
		await expect(
			body.queryByTestId("settings-agents-group"),
		).not.toBeInTheDocument();
	},
};

export const ModelsNoMatch: Story = {
	...Models,
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.type(
			body.getByRole("searchbox", { name: "Filter models and agents" }),
			"no-such-model",
		);
		await expect(
			body.getByText("No models match ‘no-such-model’.", { exact: true }),
		).toBeVisible();
		await expect(body.getByRole("button", { name: "Clear" })).toBeVisible();
		await expect(body.queryAllByRole("switch")).toHaveLength(0);
	},
};

export const Claude: Story = {
	args: { initialTab: "claude" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const disclosure = canvas.getByRole("button", {
			name: "Attribution Commit · PR · Session link",
		});
		await expect(disclosure).toHaveAttribute("aria-expanded", "false");
		await expect(
			canvas.queryByTestId("claude-setting-attribution"),
		).not.toBeInTheDocument();
		await scrollSettingsIntoView(
			canvas.getByTestId("claude-attribution-group"),
			"end",
		);
	},
};

export const ClaudeLight: Story = { ...Claude, globals: { theme: "light" } };

export const ClaudeAttributionExpanded: Story = {
	args: { initialTab: "claude" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const disclosure = canvas.getByRole("button", {
			name: "Attribution Commit · PR · Session link",
		});
		await userEvent.click(disclosure);
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		// The synthetic click leaves keyboard focus; the frame should show the open group, not a ring.
		disclosure.blur();
		await expect(
			canvas.getByTestId("claude-setting-attribution-commit-input"),
		).toBeVisible();
		await expect(
			canvas.getByTestId("claude-setting-attribution-pr-input"),
		).toBeVisible();
		await expect(
			within(canvas.getByTestId("claude-setting-attribution")).getByRole(
				"switch",
			),
		).toBeVisible();
		await expect(
			canvas.getByTestId("claude-setting-attribution-provenance"),
		).toBeVisible();
		await scrollSettingsIntoView(
			canvas.getByTestId("claude-attribution-group"),
			"end",
		);
	},
};

export const Usage: Story = {
	args: { initialTab: "usage" },
};

export const UsageLight: Story = { ...Usage, globals: { theme: "light" } };

/** Three Claude accounts in auto-switch order: normal, warning and limited. */
export const UsageAccounts: Story = {
	args: { initialTab: "usage" },
	beforeEach: () => {
		const accounts = [
			{ id: "claude", name: "Personal Claude", plan: "Max 20x" },
			{ id: "work-claude", name: "Work Claude", plan: "Team" },
			{ id: "lab-claude", name: "Lab Claude", plan: "Pro" },
		];
		applyInstanceListResponse({
			instances: accounts.map(({ id, name }, index) => ({
				id,
				name,
				driver: "claude",
				isDefault: index === 0,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1_772_011_800_000 + index * 60_000,
				usageEligible: true,
			})),
		});
		// The visual suite pins Date.now(), so offsets from it render the same times.
		const at = (minutes: number) =>
			new Date(Date.now() + minutes * 60_000).toISOString();
		applyUsageReadings(
			accounts.map(({ id, plan }, index) => ({
				accountId: id,
				harness: "claude",
				status: index === 2 ? "limited" : "available",
				planLabel: plan,
				windows: [
					{
						kind: "five_hour",
						utilization: [42, 91, 100][index] ?? 0,
						resetsAt: at([185, 62, 140][index] ?? 0),
					},
					{
						kind: "seven_day",
						utilization: [18, 64, 71][index] ?? 0,
						resetsAt: at(2 * 24 * 60 + 47),
					},
					...(index === 0
						? [
								{
									kind: "seven_day_model" as const,
									model: "Opus",
									utilization: 9,
								},
							]
						: []),
				],
				readAt: Date.now() - 120_000,
				stale: false,
			})),
		);
	},
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			body.getByTestId("usage-settings-status-claude"),
		).toHaveTextContent("Current");
		await expect(
			getComputedStyle(body.getByTestId("usage-settings-status-claude")).color,
		).toBe(
			canvasElement.ownerDocument.documentElement.classList.contains(
				"light-theme",
			)
				? "rgb(18, 113, 54)"
				: "rgb(62, 207, 142)",
		);
		await expect(
			body.getByTestId("usage-settings-status-work-claude"),
		).toHaveTextContent("91% of 5-hour window");
		const limited = usageState.readings.find(
			(account) => account.accountId === "lab-claude",
		);
		const time = usageResetTime(
			limited?.windows.find((window) => window.kind === "five_hour")?.resetsAt,
		);
		await expect(
			body.getByTestId("usage-settings-status-lab-claude"),
		).toHaveTextContent(`Limited until ${time}`);
		const value = body.getByTestId(
			"usage-settings-card-lab-claude-five_hour-value",
		);
		await expect(value).toHaveTextContent(time);
		await expect(getComputedStyle(value).fontFamily).toContain("Geist Mono");
		await expect(getComputedStyle(value).color).toBe(
			getComputedStyle(body.getByTestId("usage-settings-status-lab-claude"))
				.color,
		);
	},
};

export const UsageAccountsLight: Story = {
	...UsageAccounts,
	globals: { theme: "light" },
};
export const Server: Story = {
	args: { initialTab: "server" },
	beforeEach: () => {
		if (serverStatus.status)
			serverStatus.status = { ...serverStatus.status, keepAwake: true };
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const stop = canvas.getByTestId("server-shutdown-btn");
		await expect(stop).toHaveTextContent("Stop");
		await expect(stop.querySelector("svg")).not.toBeNull();
		await expect(
			canvas.getByTestId("server-restart-btn").querySelector("svg"),
		).not.toBeNull();
		await expect(stop.getBoundingClientRect().height).toBe(
			sessionViewState.compact ? 34 : 28,
		);
		await expect(
			stop.getBoundingClientRect().left -
				canvas.getByTestId("server-restart-btn").getBoundingClientRect().right,
		).toBe(6);
		await expect(getComputedStyle(stop).borderTopWidth).toBe("0px");
		for (const id of ["server-pin-set-btn", "server-power-edit"]) {
			const action = canvas.getByTestId(id);
			await expect(action.getBoundingClientRect().height).toBe(28);
			await expect(getComputedStyle(action).borderTopWidth).toBe("0px");
		}
		for (const id of [
			"server-access-settings",
			"server-security-settings",
			"server-power-settings",
		]) {
			await expect(
				canvas.getByTestId(id).querySelector("[data-settings-icon] svg"),
			).not.toBeNull();
		}
		const url = canvas.getByText("https://conduit.example.ts.net");
		await canvasElement.ownerDocument.fonts.ready;
		const fonts = await canvasElement.ownerDocument.fonts.load(
			'400 11.5px "Geist Mono"',
			url.textContent ?? "",
		);
		await expect(fonts.length).toBeGreaterThan(0);
		for (const font of fonts) await expect(font.status).toBe("loaded");
		const urlStyle = getComputedStyle(url);
		await expect(urlStyle.fontFamily).toContain("Geist Mono");
		await expect(urlStyle.fontSize).toBe("11.5px");
		await expect(urlStyle.fontWeight).toBe("400");
		await expect(url).toBeVisible();
		const description = url.parentElement;
		if (!description) throw new Error("Server URL description is missing");
		const urlBox = url.getBoundingClientRect();
		const descriptionBox = description.getBoundingClientRect();
		await expect(urlBox.left).toBeGreaterThanOrEqual(descriptionBox.left);
		await expect(urlBox.right).toBeLessThanOrEqual(descriptionBox.right);
		await expect(urlBox.top).toBeGreaterThanOrEqual(descriptionBox.top);
		await expect(urlBox.bottom).toBeLessThanOrEqual(descriptionBox.bottom);
		const browsers = canvas.getByTestId("server-status-browsers");
		await expect(getComputedStyle(browsers).whiteSpace).toBe("nowrap");
		await expect(browsers.textContent?.trim().startsWith("·")).toBe(true);
		const logs = within(canvas.getByTestId("server-logs-group")).getByRole(
			"button",
			{ name: /^Logs\b/ },
		);
		await expect(logs).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(logs);
		await expect(
			canvas.getByRole("button", { name: /^Log level\b/ }),
		).toHaveAttribute("data-value", "info");
		await userEvent.click(logs);
		await expect(logs).toHaveAttribute("aria-expanded", "false");
		// The fixture has no PIN, so this frame is also the PIN-off state.
		await expect(
			canvas.getByTestId("server-access-settings"),
		).toHaveTextContent("https://conduit.example.ts.net");
		await expect(
			canvas.getByRole("switch", { name: "Toggle Tailscale Serve" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			within(canvas.getByTestId("server-startup-settings")).getByRole("button"),
		).toHaveAttribute("aria-expanded", "false");
		await expect(
			canvas.getByTestId("server-security-settings"),
		).toHaveTextContent(
			"Off · anyone who can reach this address can open conduit",
		);
		await expect(canvas.getByTestId("server-pin-set-btn")).toBeVisible();
		await expect(
			canvas.getByRole("switch", { name: "Toggle keep computer awake" }),
		).toBeChecked();
		await expect(
			canvas.getByTestId("server-power-command-value"),
		).toHaveTextContent("caffeinate -di");
		await expect(canvas.getByTestId("server-status-uptime")).toHaveTextContent(
			"up 3d 4h",
		);
		await expect(canvas.getByTestId("server-status-version")).toHaveTextContent(
			"0.42.1",
		);
		await expect(canvas.getByTestId("server-status-port")).toHaveTextContent(
			"port 2633",
		);
		await expect(
			canvas.getByTestId("server-status-browsers"),
		).toHaveTextContent("· 2 browsers connected");
		await userEvent.click(canvas.getByTestId("server-shutdown-btn"));
		await expect(canvas.getByTestId("server-shutdown-cancel")).toHaveFocus();
		await userEvent.click(canvas.getByTestId("server-shutdown-cancel"));
		await expect(
			canvas.queryByTestId("server-shutdown-confirmation"),
		).not.toBeInTheDocument();
		(canvasElement.ownerDocument.activeElement as HTMLElement | null)?.blur();
		await scrollSettingsIntoView(
			canvas.getByTestId("server-startup-settings"),
			"end",
		);
	},
};

export const ServerLight: Story = { ...Server, globals: { theme: "light" } };

export const ServerStartupExpanded: Story = {
	args: { initialTab: "server" },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const startup = canvas.getByTestId("server-startup-settings");
		const disclosure = within(startup).getByRole("button");
		await userEvent.click(disclosure);
		await expect(disclosure).toHaveAttribute("aria-expanded", "true");
		disclosure.blur();
		await expect(canvas.getByTestId("server-startup-port")).toHaveTextContent(
			"2633",
		);
		await expect(canvas.getByTestId("server-startup-host")).toHaveTextContent(
			"0.0.0.0",
		);
		await expect(canvas.getByTestId("server-startup-https")).toHaveTextContent(
			"Off",
		);
		await expect(canvas.getByTestId("server-startup-login")).toHaveTextContent(
			"Installed",
		);
		await expect(within(startup).queryByRole("switch")).not.toBeInTheDocument();
		await scrollSettingsIntoView(startup, "end");
	},
};

export const PowerCommandEdit: Story = {
	...Server,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("server-power-edit"));
		await expect(canvas.getByTestId("server-power-command")).toHaveFocus();
		await expect(canvas.getByTestId("server-power-command")).toHaveValue(
			"caffeinate",
		);
		await expect(canvas.getByTestId("server-power-args")).toHaveValue("-di");
		await expect(canvas.getByTestId("server-power-save")).toBeVisible();
		await expect(canvas.getByTestId("server-power-cancel")).toBeVisible();
		await scrollSettingsIntoView(
			canvas.getByTestId("server-power-settings"),
			"end",
		);
	},
};

export const PowerNotAvailable: Story = {
	args: { initialTab: "server" },
	beforeEach: () => {
		if (serverStatus.status)
			serverStatus.status = { ...serverStatus.status, keepAwakeCommand: null };
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByRole("switch", { name: "Toggle keep computer awake" }),
		).toBeDisabled();
		await expect(canvas.getByTestId("server-power-settings")).toHaveTextContent(
			"Not available on this computer",
		);
		await expect(
			canvas.queryByTestId("server-power-edit"),
		).not.toBeInTheDocument();
		await scrollSettingsIntoView(
			canvas.getByTestId("server-power-settings"),
			"end",
		);
	},
};

export const PinOn: Story = {
	args: { initialTab: "server" },
	beforeEach: () => {
		if (serverStatus.status)
			serverStatus.status = { ...serverStatus.status, pinEnabled: true };
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const security = canvas.getByTestId("server-security-settings");
		await expect(security).toHaveTextContent(
			"On · asked once on each new device",
		);
		await expect(canvas.getByTestId("server-pin-change-btn")).toBeVisible();
		await expect(canvas.getByTestId("server-pin-remove-btn")).toBeVisible();
		await scrollSettingsIntoView(security, "nearest");
	},
};

export const ChangePin: Story = {
	...PinOn,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("server-pin-change-btn"));
		await expect(canvas.getByTestId("server-pin-current")).toHaveFocus();
		await expect(
			canvas.getByLabelText("New PIN", { exact: true }),
		).toBeVisible();
		await expect(canvas.getByLabelText("Confirm new PIN")).toBeVisible();
		await expect(canvas.getByTestId("server-pin-form")).toHaveTextContent(
			"Every browser, including this one, will ask for the new PIN.",
		);
		await scrollSettingsIntoView(
			canvas.getByTestId("server-security-settings"),
			"end",
		);
	},
};

/**
 * Also the a11y gate for the setup-scenario rows. They were bare `<button>`s
 * that announced nothing about the region they opened; on ui/Disclosure they
 * always carry `aria-expanded`, and this asserts the value actually tracks the
 * state rather than being a constant.
 */
export const QuickStartExpanded: Story = {
	args: { initialTab: "server" },
	play: async ({ canvasElement }) => {
		// Click-driven focus scrolls too, so wait for layout before interacting.
		await canvasElement.ownerDocument.fonts.ready;
		const guides = within(
			within(canvasElement).getByTestId("opencode-setup-guides"),
		);
		await userEvent.click(guides.getByRole("button", { name: /Setup guides/ }));
		const row = guides.getByRole("button", { name: /^Direct key/ });

		await expect(row).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(row);

		await expect(
			guides.getByText(/opencode config set provider anthropic/),
		).toBeVisible();
		await expect(row).toHaveAttribute("aria-expanded", "true");
		// Show the opened guide at the top. Without a settled scroll, focusing a
		// row this close to the phone fold scrolls by 0 or 1px.
		await scrollSettingsIntoView(row, "start");
	},
};

/** Instances sit below the fold on the Server page, so scroll them in. */
const showInstances: Story["play"] = async ({ canvasElement }) => {
	await scrollSettingsIntoView(
		within(canvasElement).getByTestId("add-instance-btn"),
		"start",
	);
};

export const InstancesPopulated: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	play: showInstances,
};

export const InstanceExpanded: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const row = canvas.getByRole("button", {
			name: /Local OpenCode/,
		});

		await expect(row).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(row);

		await expect(
			within(canvas.getByTestId("instance-row-instance-local")).getByRole(
				"button",
				{ name: "Stop" },
			),
		).toBeVisible();
		await expect(canvas.getByTestId("edit-instance-btn")).toBeVisible();
		await expect(canvas.getByText("Started by", { exact: true })).toBeVisible();
		await expect(row).toHaveAttribute("aria-expanded", "true");
	},
};

export const ClaudeAccountExpanded: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		await canvasElement.ownerDocument.fonts.ready;
		const canvas = within(canvasElement);
		const accountElement = canvas.getByTestId("instance-row-work-claude");
		const account = within(accountElement);
		const row = account.getByRole("button", { name: /Work Claude/ });
		await expect(row).toHaveAttribute("aria-expanded", "false");
		await userEvent.click(row);
		await expect(row).toHaveAttribute("aria-expanded", "true");
		await expect(
			account.getByText("Config dir", { exact: true }),
		).toBeVisible();
		await expect(
			account.getByText("Sessions you move to it, and auto-switch"),
		).toBeVisible();
		await expect(account.getByTestId("edit-instance-btn")).toBeVisible();
		await expect(account.getByTestId("remove-instance-btn")).toBeVisible();
		await expect(
			account.queryByTestId("rename-instance-btn"),
		).not.toBeInTheDocument();
		await scrollSettingsIntoView(accountElement, "nearest");
		const scroller = accountElement.closest(".settings-content");
		if (!scroller) throw new Error("Settings content is missing");
		const accountBox = accountElement.getBoundingClientRect();
		const viewport = scroller.getBoundingClientRect();
		await expect(accountBox.top).toBeGreaterThanOrEqual(viewport.top);
		await expect(accountBox.bottom).toBeLessThanOrEqual(viewport.bottom);
	},
};

export const DefaultClaudeAccountEdit: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		await canvasElement.ownerDocument.fonts.ready;
		const canvas = within(canvasElement);
		const account = within(canvas.getByTestId("instance-row-claude"));
		await userEvent.click(
			account.getByRole("button", { name: /Personal Claude/ }),
		);
		// Every account can be removed, the default included (conduit-test-g4zp.10).
		await expect(account.getByTestId("remove-instance-btn")).toBeVisible();
		await expect(
			account.queryByText("Applies after restart"),
		).not.toBeInTheDocument();
		await userEvent.click(account.getByTestId("edit-instance-btn"));
		await expect(canvas.getByTestId("instance-form-name")).toHaveValue(
			"Personal Claude",
		);
		await expect(canvas.getByTestId("instance-form-configdir")).toHaveValue(
			"~/.claude",
		);
		await expect(
			within(canvas.getByTestId("instance-form")).getByText(
				/Folder changes apply on the next turn/,
			),
		).toBeVisible();
		await expect(
			canvas.queryByRole("radiogroup", { name: "Type" }),
		).not.toBeInTheDocument();
		await scrollSettingsIntoView(
			canvas.getByTestId("instance-form"),
			"nearest",
		);
	},
};

export const InstancesEmpty: Story = {
	args: { initialTab: "server" },
	beforeEach: () => {
		populateInstances();
		applyInstanceListResponse({
			instances: getCachedInstances().filter(
				(instance) => instance.driver === "claude",
			),
		});
		return replyRpc("DetectProxy", () => ({ found: true, port: 8317 }));
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("opencode-empty-state")).toHaveTextContent(
			"opencode serve --port 4098",
		);
		const guides = canvas.getByTestId("opencode-setup-guides");
		await waitFor(() =>
			expect(guides).toHaveTextContent("Direct key · CCS ✓ · Custom"),
		);
		await expect(within(guides).getByRole("button")).toHaveAttribute(
			"aria-expanded",
			"false",
		);
		await scrollSettingsIntoView(
			canvas.getByTestId("add-instance-btn"),
			"start",
		);
	},
};

export const InstanceAddOpenCode: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		await canvasElement.ownerDocument.fonts.ready;
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("add-instance-btn"));
		await userEvent.click(canvas.getByTestId("instance-form-driver-opencode"));
		await userEvent.type(
			canvas.getByTestId("instance-form-name"),
			"Staging OC",
		);
		await userEvent.type(canvas.getByTestId("instance-form-port"), "4098");
		await expect(canvas.getByTestId("instance-form-managed")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(
			canvas.queryByTestId("instance-form-env"),
		).not.toBeInTheDocument();
		await expect(canvas.getByTestId("instance-form-save")).toHaveTextContent(
			"Add instance",
		);
		await scrollSettingsIntoView(
			canvas.getByTestId("instance-form"),
			"nearest",
		);
	},
};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};

/**
 * The add/edit instance form. Its Cancel and Save buttons appeared in no
 * baseline of any kind, so the component swap would have had nothing holding them
 * to zero pixel diff. Captured deliberately BEFORE that migration: a fidelity
 * gate can only prove "nothing moved" against an image of the old markup.
 */
export const InstanceForm: Story = {
	args: { initialTab: "server" },
	play: async ({ canvasElement }) => {
		await canvasElement.ownerDocument.fonts.ready;
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByTestId("add-instance-btn"));
		await expect(canvas.getByTestId("instance-form-save")).toBeVisible();
		// Park focus on the Name field, NOT on Add. Storybook's click ends in a
		// programmatic .focus(), which Chromium treats as keyboard focus, so the
		// baseline would otherwise bake in Add's focus ring — and that ring is
		// exactly what changes when Add moves onto Button. A fidelity baseline
		// has to be blind to the migration it is about to police.
		canvas.getByTestId("instance-form-name").focus({ preventScroll: true });
		await scrollSettingsIntoView(
			canvas.getByTestId("instance-form"),
			"nearest",
		);
	},
};

/**
 * Hover on Server. The existing Hover story sits on General,
 * so every hover style in the instances list — Scan Now, Add, and the per-row
 * actions — was uncaptured. That matters more than usual here: the component swap
 * of this panel needs `!` overrides mostly to hold HOVER colours that differ
 * from the Button variants, and an override no baseline can see is an override
 * no gate can prove.
 */
export const InstancesHover: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	parameters: { pseudo: { hover: true } },
};

/**
 * Hover on an EXPANDED instance row, where Stop, Edit and Remove live.
 * Those buttons are the densest cluster of hover colours in
 * the panel, and the component swap needs `!` overrides to hold them.
 *
 * The hover state is applied by hand instead of through `parameters.pseudo`,
 * and it is applied to `document.body`. Neither is a style preference; both are
 * scars.
 *
 * `parameters.pseudo` cannot be used at all here. The addon's decorator emits
 * UPDATE_GLOBALS on first render, Storybook re-renders the story from scratch,
 * the Svelte component remounts, and `expandedInstanceId` goes back to null.
 * `play` does NOT run again on a globals-driven re-render, so the row silently
 * collapses after `play` expanded it. Writing `play` idempotently does not
 * help: nothing runs it a second time.
 *
 * `document.body` rather than the canvas, because the addon's other effect
 * calls `applyParameter` on `#storybook-root`, and that REMOVES every
 * `pseudo-*` class before adding back the ones the story asked for. It fires
 * after `play` finishes, so a class `play` put on the canvas is stripped by the
 * time the screenshot is taken. Body is outside its reach, and the rewritten
 * rules are descendant selectors, so they match from there just as well.
 *
 * Both mistakes captured a green baseline showing the wrong thing — first a
 * collapsed panel, then an expanded one with no hover. Nothing asserts that a
 * story shows what its name claims, so the only proof is to delete the line and
 * watch the gate go red.
 */
export const InstanceExpandedHover: Story = {
	args: { initialTab: "server" },
	beforeEach: populateInstances,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			canvas.getByRole("button", { name: /Local OpenCode/ }),
		);
		await expect(canvas.getByTestId("edit-instance-btn")).toBeVisible();
		canvasElement.ownerDocument.body.classList.add("pseudo-hover-all");
	},
};
