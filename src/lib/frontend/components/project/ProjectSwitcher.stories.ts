import type { Meta, StoryObj } from "@storybook/svelte-vite";
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

export const MultipleProjects: Story = {
	args: {
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
