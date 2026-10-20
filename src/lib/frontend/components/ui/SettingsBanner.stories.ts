import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { createRawSnippet } from "svelte";
import SettingsBanner from "./SettingsBanner.svelte";

const meta = {
	title: "UI/SettingsBanner",
	component: SettingsBanner,
	parameters: { layout: "padded" },
	args: {
		children: createRawSnippet(() => ({
			render: () =>
				"<span><b>lab</b> hit its 5-hour limit and resets at 3:40 pm. Sessions switched to <b>personal</b>, which has 58% of its window left.</span>",
		})),
	},
} satisfies Meta<typeof SettingsBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Limited: Story = {};
export const LimitedLight: Story = { globals: { theme: "light" } };
export const Warning: Story = { args: { tone: "warning" } };
export const Neutral: Story = { args: { tone: "neutral" } };
