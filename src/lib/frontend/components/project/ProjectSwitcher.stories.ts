import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { instanceState } from "../../stores/instance.svelte.js";
import type { OpenCodeInstance } from "../../types.js";
import ProjectSwitcher from "./ProjectSwitcher.svelte";

const meta = {
	title: "Project/ProjectSwitcher",
	component: ProjectSwitcher,
	tags: ["autodocs"],
	beforeEach: () => {
		instanceState.instances = [];
	},
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
async function openDropdown(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	// getByRole, not the `#project-switcher-btn` querySelector every one of these
	// stories used to do: the trigger was a <div onclick> until
	// conduit-test-de3.35.6, so this line is itself the regression gate for the
	// keyboard fix. A div has no button role and the query would throw.
	await userEvent.click(canvas.getByRole("button", { name: /Projects/ }));
	const body = within(canvasElement.ownerDocument.body);
	return await waitFor(() => body.getByTestId("project-switcher-dropdown"));
}

export const MenuOpen: Story = {
	args: multipleProjectsArgs,
	// The dropdown is absolutely positioned outside #storybook-root; an element
	// capture would show a closed menu. viewport-capture screenshots the page.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const dropdown = await openDropdown(canvasElement);
		await waitFor(() => {
			expect(
				within(dropdown).getByText("/home/user/projects/backend"),
			).toBeVisible();
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
	// conduit-test-732b: counts were hidden in the unopened dropdown.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const dropdown = await openDropdown(canvasElement);
		await waitFor(() => {
			expect(
				within(dropdown).getByText("3"),
				"The open dropdown must show Frontend App's three clients",
			).toBeVisible();
		});
	},
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

// ─── Surfaces that had no baseline at all before conduit-test-de3.35.6 ───────
//
// Four of this file's controls -- the add-project trigger, Cancel, Add and the
// instance <select> -- only render inside the open dropdown's footer, and the
// inline rename field only after a context-menu round trip. Nothing reached
// any of them, which is how three elements that could not be operated by
// keyboard survived here. Each story below asserts the ROLE of the control it
// covers, so the a11y fix is gated rather than merely captured.

export const AddProjectForm: Story = {
	args: multipleProjectsArgs,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const dropdown = await openDropdown(canvasElement);
		await userEvent.click(
			within(dropdown).getByRole("button", { name: "Add project" }),
		);
		await waitFor(() => {
			expect(
				within(dropdown).getByRole("button", { name: "Add" }),
			).toBeVisible();
			expect(
				within(dropdown).getByRole("button", { name: "Cancel" }),
			).toBeVisible();
		});
	},
};

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
		status: "healthy",
		restartCount: 0,
		createdAt: 0,
	},
];

/**
 * Two instances flips ProjectSwitcher into its grouped rendering AND is the
 * only condition under which the instance <select> exists, so one story is the
 * honest way to cover both.
 */
export const AddProjectFormGrouped: Story = {
	args: {
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
		],
		currentSlug: "frontend",
	},
	tags: ["viewport-capture"],
	beforeEach: () => {
		instanceState.instances = [...twoInstances];
	},
	play: async ({ canvasElement }) => {
		const dropdown = await openDropdown(canvasElement);
		expect(
			within(dropdown).getAllByTestId("instance-group-header"),
		).toHaveLength(2);
		await userEvent.click(
			within(dropdown).getByRole("button", { name: "Add project" }),
		);
		await waitFor(() => {
			expect(
				within(dropdown).getByRole("combobox", { name: "Instance" }),
			).toBeVisible();
		});
	},
};

export const RenamingProject: Story = {
	args: multipleProjectsArgs,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		const dropdown = await openDropdown(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const [moreBtn] = within(dropdown).getAllByRole("button", {
			name: "More options",
		});
		if (!moreBtn)
			throw new Error("RenamingProject needs a More options button");
		await userEvent.click(moreBtn);
		await userEvent.click(await body.findByRole("button", { name: "Rename" }));
		// Focus is the assertion, not setup. It used to come from a one-line
		// `use:focusOnMount` action, and an action cannot cross a component
		// boundary -- ui/TextInput absorbs `autofocus` instead.
		const field = await body.findByRole("textbox", { name: "Rename project" });
		await expect(field).toHaveFocus();
	},
};
