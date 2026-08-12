import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import ProjectSwitcher from "./ProjectSwitcher.svelte";

const meta = {
	title: "Project/ProjectSwitcher",
	component: ProjectSwitcher,
	tags: ["autodocs"],
} satisfies Meta<typeof ProjectSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SingleProject: Story = {
	args: {
		projects: [
			{
				slug: "my-app",
				title: "My Application",
				directory: "/home/user/projects/my-app",
			},
		],
		currentSlug: "my-app",
	},
};

const multipleProjectsArgs = {
	projects: [
		{
			slug: "frontend",
			title: "Frontend App",
			directory: "/home/user/projects/frontend",
		},
		{
			slug: "backend",
			title: "Backend API",
			directory: "/home/user/projects/backend",
		},
		{
			slug: "shared-lib",
			title: "Shared Library",
			directory: "/home/user/projects/shared-lib",
		},
	],
	currentSlug: "frontend",
};

export const MultipleProjects: Story = {
	args: multipleProjectsArgs,
};

/**
 * Captures the OPEN dropdown — the closed-trigger stories above cannot see the
 * menu at all, so without this the per-project directory lines added for
 * conduit-test-de3.13 would have no baseline and no reviewable artifact.
 * The play() asserts a directory is actually visible rather than merely
 * present, so the capture cannot silently show a closed menu.
 */
export const MenuOpen: Story = {
	args: multipleProjectsArgs,
	// The dropdown is absolutely positioned outside #storybook-root; an element
	// capture would show a closed menu. viewport-capture screenshots the page.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const trigger = canvasElement.querySelector<HTMLElement>(
			"#project-switcher-btn",
		);
		if (!trigger) throw new Error("project-switcher trigger not found");
		await userEvent.click(trigger);

		const body = within(canvasElement.ownerDocument.body);
		await waitFor(() => {
			expect(body.getByTestId("project-switcher-dropdown")).toBeVisible();
			expect(body.getByText("/home/user/projects/backend")).toBeVisible();
		});
	},
};

export const NoProjects: Story = {
	args: {
		projects: [],
		currentSlug: null,
	},
};

export const WithClients: Story = {
	args: {
		projects: [
			{
				slug: "frontend",
				title: "Frontend App",
				directory: "/home/user/projects/frontend",
				clientCount: 3,
			},
			{
				slug: "backend",
				title: "Backend API",
				directory: "/home/user/projects/backend",
				clientCount: 0,
			},
			{
				slug: "mobile",
				title: "Mobile App",
				directory: "/home/user/projects/mobile",
				clientCount: 1,
			},
		],
		currentSlug: "frontend",
	},
};

export const Hover: Story = {
	...SingleProject,
	parameters: { pseudo: { hover: true } },
};
