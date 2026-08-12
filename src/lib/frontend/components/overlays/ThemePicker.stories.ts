import type { Meta, StoryObj } from "@storybook/svelte-vite";
import conduitTheme from "../../../themes/conduit.json";
import opencodeLightTheme from "../../../themes/opencode-light.json";
import { themeState } from "../../stores/theme.svelte.js";
import type { Base16Theme } from "../../stores/theme-compute.js";
import { uiState } from "../../stores/ui.svelte.js";
import ThemePicker from "./ThemePicker.svelte";

const meta = {
	title: "Overlays/ThemePicker",
	component: ThemePicker,
	// The picker renders as an absolutely positioned panel outside the story root,
	// so the element capture path throws the escaped-content guard. Tag it so both
	// platforms take the same viewport capture instead of disagreeing by accident.
	tags: ["autodocs", "viewport-capture"],
	beforeEach: () => {
		uiState.sidebarCollapsed = false;
		themeState.currentThemeId = "conduit";
		themeState.themes = {
			conduit: conduitTheme as Base16Theme,
			"opencode-light": opencodeLightTheme as Base16Theme,
		};
		themeState.customThemeIds = [];
		themeState.pickerOpen = true;
	},
} satisfies Meta<typeof ThemePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Hover: Story = {
	...Default,
	parameters: { pseudo: { hover: true } },
};
