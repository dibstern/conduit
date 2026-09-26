import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { instanceState } from "../../stores/instance.svelte.js";
import type { OpenCodeInstance } from "../../types.js";
import ProjectManagerPanel from "./ProjectManagerPanel.svelte";

const meta = {
	title: "Project/ProjectManagerPanel",
	component: ProjectManagerPanel,
	tags: ["autodocs"],
	beforeEach: () => {
		instanceState.instances = [];
	},
} satisfies Meta<typeof ProjectManagerPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const twoInstances: OpenCodeInstance[] = [
	{
		id: "inst-a",
		name: "Personal",
		port: 4096,
		managed: true,
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
	},
	{
		id: "inst-b",
		name: "Work",
		port: 4097,
		managed: true,
		status: "unhealthy",
		restartCount: 0,
		createdAt: 0,
	},
];

const multipleProjectsArgs = {
	projects: [
		{
			slug: "frontend",
			title: "Frontend App",
			directory: "/home/user/projects/frontend",
			instanceId: "inst-a",
		},
		{
			slug: "backend",
			title: "Backend API",
			directory: "/home/user/projects/backend",
			instanceId: "inst-b",
		},
		{
			slug: "shared-lib",
			title: "Shared Library",
			directory: "/home/user/projects/shared-lib",
			instanceId: "inst-a",
		},
	],
	currentSlug: "frontend",
};

const groupedStory = {
	args: multipleProjectsArgs,
	beforeEach: () => {
		instanceState.instances = [...twoInstances];
	},
};

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
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("project-item")).toHaveAttribute(
			"role",
			"group",
		);
		await expect(canvas.queryAllByRole("link")).toHaveLength(0);
		await expect(
			canvas.getByRole("button", { name: "More options for My Application" }),
		).toBeVisible();
	},
};

export const MultipleProjects: Story = groupedStory;

export const WithClients: Story = {
	args: {
		projects: [
			{
				slug: "frontend",
				title: "Frontend App",
				directory: "/home/user/projects/frontend",
				clientCount: 3,
				instanceId: "inst-a",
			},
			{
				slug: "backend",
				title: "Backend API",
				directory: "/home/user/projects/backend",
				clientCount: 0,
				instanceId: "inst-b",
			},
			{
				slug: "mobile",
				title: "Mobile App",
				directory: "/home/user/projects/mobile",
				clientCount: 1,
				instanceId: "inst-a",
			},
		],
		currentSlug: "frontend",
	},
	beforeEach: () => {
		instanceState.instances = [...twoInstances];
	},
};

export const AddProjectForm: Story = {
	...groupedStory,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole("button", { name: "Add project" }));
		await waitFor(() => {
			expect(canvas.getByRole("button", { name: "Add" })).toBeVisible();
			expect(canvas.getByRole("button", { name: "Cancel" })).toBeVisible();
			expect(canvas.getByRole("combobox", { name: "Instance" })).toBeVisible();
		});
	},
};

export const RenamingProject: Story = {
	...groupedStory,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		// Exact name rather than a regex + non-null guard: getByRole throws its
		// own descriptive failure when the row is missing, so the story needs no
		// plain `throw` (which test/unit/effect/runtime-boundary-grep.test.ts
		// polices).
		await userEvent.click(
			canvas.getByRole("button", { name: "More options for Frontend App" }),
		);
		await userEvent.click(
			await body.findByRole("menuitem", { name: "Rename" }),
		);
		const field = await body.findByRole("textbox", {
			name: "Rename project",
		});
		await expect(field).toHaveFocus();
	},
};

export const NoProjects: Story = {
	args: {
		projects: [],
		currentSlug: undefined,
	},
};
