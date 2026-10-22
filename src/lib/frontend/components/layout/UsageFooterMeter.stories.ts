import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	DEFAULT_USAGE_LIMITS,
	type UsageLimitsSetting,
	type UsageReading,
} from "../../../contracts/limit-recovery.js";
import { applyInstanceListResponse } from "../../stores/instance.svelte.js";
import {
	applyUsageLimitsSetting,
	applyUsageReadings,
} from "../../stores/usage.svelte.js";
import { mockClaudeAccount, mockSession } from "../../stories/mocks.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import UsageFooterMeterFrame from "./__fixtures__/UsageFooterMeterFrame.svelte";

const accounts = ["personal", "work", "lab", "stale", "codex"] as const;
const readings: UsageReading[] = accounts.map((accountId, index) => ({
	accountId,
	harness: accountId === "codex" ? "codex" : "claude",
	status: accountId === "lab" ? "limited" : "available",
	windows: [
		{
			kind: "five_hour",
			utilization: [42, 91, 100, 47, 30][index] ?? 0,
			resetsAt: new Date(2026, 0, 1, 3, 40).toISOString(),
		},
		{ kind: "seven_day", utilization: [18, 64, 71, 52, 64][index] ?? 0 },
	],
	readAt: 1,
	stale: accountId === "stale",
}));

function seed(
	rows: readonly UsageReading[] = readings,
	warnAt: UsageLimitsSetting["warnAt"] = 80,
) {
	applyInstanceListResponse({
		instances: rows.map((reading) => ({
			...mockClaudeAccount,
			id: reading.accountId,
			colorSlot: (accounts as readonly string[]).indexOf(reading.accountId),
			name: reading.accountId,
			usageEligible: true,
		})),
	});
	applyUsageLimitsSetting({
		...DEFAULT_USAGE_LIMITS,
		order: [...accounts],
		warnAt,
	});
	applyUsageReadings(rows);
	applySessionChange({
		_tag: "snapshot",
		rows: [{ ...mockSession, accountId: "personal" }],
		sequence: 1,
	});
	applySessionChange({ _tag: "synchronized" });
	openSessionForSetup(mockSession.id, "conduit");
}

const meta = {
	title: "Layout/UsageFooterMeter",
	component: UsageFooterMeterFrame,
	tags: ["autodocs"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false, height: "640px" } },
	},
	beforeEach: () => {
		seed();
		return () => {
			applyUsageReadings([]);
			applyUsageLimitsSetting(DEFAULT_USAGE_LIMITS);
			openSessionForSetup(null);
		};
	},
} satisfies Meta<typeof UsageFooterMeterFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

const codexReading: UsageReading = {
	accountId: "codex",
	harness: "codex",
	status: "available",
	readAt: 1,
	stale: false,
	windows: [
		{
			id: "codex:primary",
			limitId: "codex",
			label: "Codex 5h",
			kind: "five_hour",
			utilization: 42,
			resetsAt: new Date(2026, 0, 1, 15, 40).toISOString(),
		},
		{
			id: "codex:secondary",
			limitId: "codex",
			label: "Codex Week",
			kind: "seven_day",
			utilization: 64,
			resetsAt: new Date(2026, 0, 5, 10, 0).toISOString(),
		},
		{
			id: "codex_spark:primary",
			limitId: "codex_spark",
			label: "Spark 5h",
			kind: "five_hour",
			utilization: 83,
			resetsAt: new Date(2026, 0, 1, 17, 10).toISOString(),
		},
		{
			id: "codex_spark:secondary",
			limitId: "codex_spark",
			label: "Spark Week",
			kind: "seven_day",
			utilization: 31,
			resetsAt: new Date(2026, 0, 6, 10, 0).toISOString(),
		},
	],
};

function seedCodex(reading: UsageReading = codexReading) {
	seed([reading]);
	applyInstanceListResponse({
		instances: [
			{
				...mockClaudeAccount,
				id: "codex",
				name: "codex",
				driver: "codex",
				usageEligible: true,
			},
		],
	});
}

export const CodexAllowances: Story = {
	beforeEach: () => seedCodex(),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.queryByTestId("usage-footer-single"),
		).not.toBeInTheDocument();
		await expect(
			canvas.getByTestId("usage-footer-heading-codex"),
		).toHaveTextContent("Codex");
		await expect(
			canvas.getByTestId("usage-footer-column-codex-five_hour"),
		).toHaveTextContent("5h");
		await expect(
			canvas.getByTestId("usage-footer-column-codex-seven_day"),
		).toHaveTextContent("Week");
		await expect(
			canvas.getByTestId("usage-footer-name-codex"),
		).toHaveTextContent(/^codex$/);
		await expect(
			canvas.getByTestId("usage-footer-name-codex-codex_spark"),
		).toHaveTextContent("codex · Spark");
		for (const window of codexReading.windows) {
			const rowId =
				window.limitId === "codex" ? "codex" : `codex-${window.limitId}`;
			const row = canvas.getByTestId(`usage-footer-row-${rowId}`);
			const value = canvas.getByTestId(
				`usage-footer-value-${rowId}-${window.kind}`,
			);
			await expect(row).toBeVisible();
			await expect(value).toHaveTextContent(`${window.utilization}%`);
			await expect(
				canvas.getByTestId(`usage-footer-cell-${rowId}-${window.kind}`),
			).toHaveAttribute("title", expect.stringContaining("Resets"));
			// Each caption must fit inside its shared grid row, including on desktop.
			const bounds = row.getBoundingClientRect();
			const caption = value.getBoundingClientRect();
			await expect(caption.top).toBeGreaterThanOrEqual(bounds.top);
			await expect(caption.bottom).toBeLessThanOrEqual(bounds.bottom);
		}
		await expect(
			canvas.getByTestId("usage-footer-cell-codex-codex_spark-five_hour"),
		).toHaveAttribute("data-level", "warning");
		await expect(canvas.queryByText(/^Resets /)).not.toBeInTheDocument();
	},
};

export const CodexAllowancesPhone: Story = {
	...CodexAllowances,
	args: { phone: true, width: 390 },
	play: async (context) => {
		await CodexAllowances.play?.(context);
		const body = within(context.canvasElement.ownerDocument.body);
		await expect(
			body.queryByTestId("usage-phone-single"),
		).not.toBeInTheDocument();
		await userEvent.click(body.getByTestId("usage-phone-dock"));
		await expect(
			await body.findByRole("dialog", { name: "Usage" }),
		).toBeVisible();
		await expect(body.getByTestId("usage-sheet-name-codex")).toHaveTextContent(
			/^codex$/,
		);
		await expect(
			body.getByTestId("usage-sheet-name-codex-codex_spark"),
		).toHaveTextContent("codex · Spark");
		await expect(
			body.getByTestId("usage-sheet-value-codex-five_hour"),
		).toHaveTextContent("42%");
		await expect(
			body.getByTestId("usage-sheet-value-codex-codex_spark-seven_day"),
		).toHaveTextContent("31%");
	},
};

export const CodexSingleLimit: Story = {
	beforeEach: () =>
		seedCodex({
			...codexReading,
			windows: codexReading.windows.filter(
				(window) => window.limitId === "codex",
			),
		}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("usage-footer-single")).toBeVisible();
		await expect(canvas.getByTestId("usage-footer-harness")).toHaveTextContent(
			"Codex",
		);
		await expect(
			canvas.getByTestId("usage-footer-column-codex-five_hour"),
		).toHaveTextContent("5h");
		await expect(
			canvas.getByTestId("usage-footer-column-codex-seven_day"),
		).toHaveTextContent("Week");
		await expect(
			canvas.getByTestId("usage-footer-value-codex-five_hour"),
		).toHaveTextContent("42%");
		await expect(
			canvas.getByTestId("usage-footer-value-codex-seven_day"),
		).toHaveTextContent("64%");
		await expect(
			canvas.queryByTestId("usage-footer-group-codex"),
		).not.toBeInTheDocument();
	},
};

export const CodexCustomWindow: Story = {
	beforeEach: () =>
		seedCodex({
			...codexReading,
			windows: codexReading.windows.map((window) =>
				window.id === "codex_spark:primary"
					? { ...window, kind: "custom", label: "Spark 15m" }
					: window,
			),
		}),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("usage-footer-name-codex-codex_spark"),
		).toHaveTextContent("codex · Spark");
		await expect(
			canvas.getByTestId("usage-footer-row-codex-codex_spark"),
		).toHaveAttribute("title", "Spark 15m: 83%");
		await expect(
			canvas.getByTestId("usage-footer-value-codex-codex_spark-five_hour"),
		).toHaveTextContent("—");
		await expect(
			canvas.getByTestId("usage-footer-value-codex-codex_spark-seven_day"),
		).toHaveTextContent("31%");
		await expect(canvas.queryByText("Spark 15m")).not.toBeInTheDocument();
		await expect(
			canvas.queryByTestId("usage-footer-column-codex-custom"),
		).not.toBeInTheDocument();
	},
};

/** Current, normal, warning, limited, stale and a second harness in one meter. */
export const States: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("usage-footer-heading-claude"),
		).toHaveTextContent("Claude");
		await expect(
			canvas.getByTestId("usage-footer-column-claude-seven_day"),
		).toHaveTextContent("Week");
		await expect(
			canvas.getByTestId("usage-footer-row-personal"),
		).toHaveAttribute("data-default", "true");
		await expect(
			canvas.getByTestId("usage-footer-cell-work-five_hour"),
		).toHaveAttribute("data-level", "warning");
		await expect(
			canvas.getByTestId("usage-footer-value-lab-five_hour"),
		).toHaveTextContent("3:40");
		await expect(
			canvas.getByTestId("usage-footer-cell-lab-seven_day"),
		).toHaveAttribute("data-level", "normal");
		await expect(
			canvas.getByTestId("usage-footer-value-stale-five_hour"),
		).toHaveTextContent("—");
		await expect(
			canvas.getByTestId("usage-footer-bar-stale-five_hour"),
		).toBeEmptyDOMElement();
		const dots = ["personal", "work", "lab", "stale"].map(
			(id) =>
				getComputedStyle(canvas.getByTestId(`usage-footer-dot-${id}`))
					.backgroundColor,
		);
		await expect(new Set(dots).size).toBe(dots.length);
		await expect(
			getComputedStyle(
				canvas.getByTestId("usage-footer-column-claude-five_hour"),
			).color,
		).toBe(
			getComputedStyle(canvas.getByTestId("usage-footer-value-stale-five_hour"))
				.color,
		);
		await expect(
			getComputedStyle(
				canvas.getByTestId("usage-footer-value-personal-five_hour"),
			).fontSize,
		).toBe("11px");
	},
};

export const SingleAccount: Story = {
	beforeEach: () => {
		seed(readings.slice(0, 1));
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("usage-footer-harness")).toHaveTextContent(
			"Claude",
		);
		await expect(
			canvas.getByTestId("usage-footer-value-personal-five_hour"),
		).toHaveTextContent("42%");
		await expect(
			canvas.getByTestId("usage-footer-value-personal-seven_day"),
		).toHaveTextContent("18%");
	},
};

export const SingleWarning: Story = {
	beforeEach: () => {
		seed(readings.filter((reading) => reading.accountId === "work"));
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("usage-footer-cell-work-five_hour"),
		).toHaveAttribute("data-level", "warning");
	},
};

export const SingleLimited: Story = {
	beforeEach: () => {
		seed(readings.filter((reading) => reading.accountId === "lab"));
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("usage-footer-value-lab-five_hour"),
		).toHaveTextContent("3:40");
	},
};

export const SingleStale: Story = {
	beforeEach: () => {
		seed(readings.filter((reading) => reading.accountId === "stale"));
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("usage-footer-value-stale-five_hour"),
		).toHaveTextContent("—");
		await expect(
			canvas.getByTestId("usage-footer-bar-stale-five_hour"),
		).toBeEmptyDOMElement();
	},
};

export const MinimumWidth: Story = {
	args: { width: 180 },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("usage-footer-value-personal-five_hour"),
		).toBeVisible();
		await expect(
			canvas.getByTestId("usage-footer-cell-personal-seven_day"),
		).not.toBeVisible();
	},
};

export const WarningsOff: Story = {
	beforeEach: () => {
		seed(readings, "off");
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("usage-footer-cell-work-five_hour"),
		).toHaveAttribute("data-level", "normal");
		await expect(
			canvas.getByTestId("usage-footer-cell-lab-five_hour"),
		).toHaveAttribute("data-level", "danger");
	},
};

export const PhoneDock: Story = {
	args: { phone: true, width: 393 },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.queryByTestId("usage-footer-heading-claude"),
		).not.toBeInTheDocument();
		await expect(canvas.getByTestId("usage-footer-row-personal")).toBeVisible();
		await expect(canvas.getByTestId("usage-footer-row-work")).toBeVisible();
		await expect(canvas.getByTestId("usage-footer-row-lab")).toBeVisible();
		await expect(
			canvas.getByTestId("usage-phone-more-count"),
		).toHaveTextContent("+2 more");
	},
};

export const PhoneSingleAccount: Story = {
	...SingleAccount,
	args: { phone: true, width: 393 },
};

export const PhoneHiddenCodexAccount: Story = {
	args: { phone: true, width: 393 },
	beforeEach: () => {
		seed(
			readings.filter(
				(reading) =>
					reading.accountId === "personal" || reading.accountId === "codex",
			),
		);
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("usage-phone-more-count"),
		).toHaveTextContent("+1 Codex account");
		const probe = document.createElement("span");
		probe.className = "text-text-dimmer";
		canvasElement.append(probe);
		await expect(
			getComputedStyle(canvas.getByTestId("usage-phone-more-count")).color,
		).toBe(getComputedStyle(probe).color);
		probe.remove();
	},
};

export const PhoneSheet: Story = {
	...PhoneDock,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("usage-phone-dock"));
		await expect(
			await body.findByRole("dialog", { name: "Usage" }),
		).toBeVisible();
		await expect(body.getByTestId("usage-sheet-row-stale")).toBeVisible();
		await expect(
			body.getByTestId("usage-sheet-heading-codex"),
		).toHaveTextContent("Codex");
		await expect(body.getByTestId("usage-sheet-row-personal")).toHaveAttribute(
			"data-default",
			"true",
		);
		await expect(
			body.getByTestId("usage-sheet-value-lab-five_hour"),
		).toHaveTextContent("3:40");
	},
};

export const PhoneSheetLight: Story = {
	...PhoneSheet,
	globals: { theme: "light" },
};
