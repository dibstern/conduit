import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { DEFAULT_USAGE_LIMITS } from "../../../contracts/limit-recovery.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { applyUsageReadings, usageState } from "../../stores/usage.svelte.js";
import UsageFooterMeter from "./UsageFooterMeter.svelte";

const meta = {
	title: "Layout/UsageFooterMeter",
	component: UsageFooterMeter,
	tags: ["autodocs", "viewport-capture"],
	parameters: { docs: { story: { inline: false } } },
	args: { phone: true },
	beforeEach: () => {
		const instances = instanceState.instances;
		const readings = usageState.readings;
		const limits = usageState.limits;
		usageState.limits = DEFAULT_USAGE_LIMITS;
		instanceState.instances = ["Personal", "Work", "Side projects"].map(
			(name, i) => ({
				id: `sheet-account-${i}`,
				name,
				driver: "claude",
				usageEligible: true,
				isDefault: i === 0,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 0,
			}),
		);
		applyUsageReadings(
			[20, 45, 62].map((utilization, i) => ({
				accountId: `sheet-account-${i}`,
				harness: "claude",
				status: "available",
				stale: false,
				readAt: 1_790_000_000_000,
				windows: [
					{ kind: "five_hour", utilization },
					{ kind: "seven_day", utilization: utilization + 8 },
				],
			})),
		);
		return () => {
			instanceState.instances = instances;
			applyUsageReadings(readings);
			usageState.limits = limits;
		};
	},
} satisfies Meta<typeof UsageFooterMeter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sheet: Story = {
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(body.getByTestId("usage-phone-dock"));
		await expect(
			await body.findByRole("dialog", { name: "Usage" }),
		).toBeVisible();
		await expect(body.getByTestId("usage-sheet")).toBeVisible();
	},
};
export const SheetLight: Story = { ...Sheet, globals: { theme: "light" } };
