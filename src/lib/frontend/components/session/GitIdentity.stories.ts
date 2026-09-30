import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, within } from "storybook/test";
import GitIdentity from "./GitIdentity.svelte";

const meta = {
	title: "Session/GitIdentity",
	component: GitIdentity,
	tags: ["autodocs"],
	args: { project: "conduit", git: undefined },
} satisfies Meta<typeof GitIdentity>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NoGit: Story = {};

export const BranchOnly: Story = {
	args: { git: { branch: "main" } },
};

export const BranchAndWorktree: Story = {
	args: { git: { branch: "feature/session-bar", worktree: "17xt" } },
};

export const Dirty: Story = {
	args: {
		git: { branch: "feature/session-bar", worktree: "17xt", dirty: true },
	},
};

export const Narrow: Story = {
	args: {
		project: "conduit-project-with-a-very-long-name",
		git: {
			branch: "feature/git-ui",
			worktree: "linked-worktree-with-a-long-name",
			dirty: true,
		},
	},
	play: async ({ canvasElement }) => {
		const identity = within(canvasElement).getByTestId("session-bar-identity");
		// Size the story's own wrapper: #storybook-root outlives the story, so
		// styling it would leak the narrow width into the next one.
		const container = identity.parentElement;
		expect(container).not.toBeNull();
		if (!container) return;
		container.style.width = "200px";
		const project = within(identity).getByTitle(/^conduit-project/);
		const branch = within(identity).getByTitle(/^Branch:/);
		expect(identity.getBoundingClientRect().right).toBeLessThanOrEqual(
			container.getBoundingClientRect().right,
		);
		expect(project.scrollWidth).toBeGreaterThan(project.clientWidth);
		expect(branch.scrollWidth).toBe(branch.clientWidth);
		await expect(
			within(identity).getByText("Uncommitted changes"),
		).toBeInTheDocument();
	},
};
