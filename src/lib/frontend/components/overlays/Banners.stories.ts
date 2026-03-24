import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { uiState } from "../../stores/ui.svelte.js";
import Banners from "./Banners.svelte";

const meta = {
	title: "Overlays/Banners",
	component: Banners,
	tags: ["autodocs"],
	parameters: { layout: "fullscreen" },
	beforeEach: () => {
		// Reset banners for each story
		uiState.banners = [];
	},
} satisfies Meta<typeof Banners>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UpdateBanner: Story = {
	beforeEach: () => {
		uiState.banners = [
			{
				id: "update-1",
				variant: "update",
				icon: "circle-arrow-up",
				text: "A new version is available:",
				dismissible: true,
				version: "v1.2.3",
			},
		];
	},
};

export const OnboardingBanner: Story = {
	beforeEach: () => {
		uiState.banners = [
			{
				id: "onboarding-1",
				variant: "onboarding",
				icon: "zap",
				text: "Welcome! Get started by creating your first session.",
				dismissible: false,
			},
		];
	},
};

export const SkipPermissionsBanner: Story = {
	beforeEach: () => {
		uiState.banners = [
			{
				id: "skip-perms-1",
				variant: "skip-permissions",
				icon: "shield-off",
				text: "Permissions are disabled. Tools will run without approval.",
				dismissible: true,
			},
		];
	},
};

export const MultipleBanners: Story = {
	beforeEach: () => {
		uiState.banners = [
			{
				id: "update-1",
				variant: "update",
				icon: "circle-arrow-up",
				text: "A new version is available:",
				dismissible: true,
				version: "v1.2.3",
			},
			{
				id: "skip-perms-1",
				variant: "skip-permissions",
				icon: "shield-off",
				text: "Permissions are disabled. Tools will run without approval.",
				dismissible: true,
			},
		];
	},
};

export const DismissibleBanner: Story = {
	beforeEach: () => {
		uiState.banners = [
			{
				id: "dismissible-1",
				variant: "onboarding",
				icon: "info",
				text: "This banner can be dismissed by clicking the close button.",
				dismissible: true,
			},
		];
	},
};
