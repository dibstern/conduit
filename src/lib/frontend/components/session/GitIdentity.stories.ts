import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import GitIdentity from "./GitIdentity.svelte";

const meta = {
	title: "Session/GitIdentity",
	component: GitIdentity,
	tags: ["autodocs"],
	args: { directory: "/src/conduit", git: undefined },
	beforeEach: () => {
		sessionViewState.compact = false;
	},
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
		directory: "/src/conduit-project-with-a-very-long-name",
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
		expect(project.getBoundingClientRect().width).toBeGreaterThanOrEqual(
			Number.parseFloat(getComputedStyle(project).minWidth),
		);
		expect(branch.scrollWidth).toBe(branch.clientWidth);
		await expect(
			within(identity).getByText("Uncommitted changes"),
		).toBeInTheDocument();
	},
};

export const AheadBehind: Story = {
	args: { git: { branch: "main", ahead: 3, behind: 1 } },
};

export const Detached: Story = { args: { git: { head: "a1b2c3d" } } };

export const Rebasing: Story = {
	args: { git: { branch: "feat/x", operation: "rebase", dirty: true } },
};

export const Merged: Story = {
	args: { git: { branch: "feat/x", merged: true } },
};

export const DetailsOpen: Story = {
	tags: ["viewport-capture"],
	args: {
		git: {
			branch: "fix/draft-menus",
			worktree: "conduit-wt-draft",
			ahead: 3,
			behind: 1,
			dirty: true,
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-identity"),
		);
		await expect(
			within(document.body).getByRole("menu", { name: "Checkout" }),
		).toHaveTextContent("/src/conduit");
	},
};

export const WorktreeMenu: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit-one",
		git: { branch: "feature/one", worktree: "conduit-one", dirty: true },
		loadWorktrees: async () => ({
			directory: "/src/conduit-one",
			worktrees: [
				{ path: "/src/conduit", branch: "main", main: true },
				{ path: "/src/conduit-one", branch: "feature/one", main: false },
				{ path: "/src/conduit-two", branch: "feature/two", main: false },
			],
		}),
		onmove: async () => {},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-identity"),
		);
		await userEvent.click(
			within(document.body).getByRole("menuitem", {
				name: "Move to worktree…",
			}),
		);
		await expect(
			within(document.body).getByTestId("current-worktree"),
		).toBeVisible();
		await expect(
			within(document.body).getByRole("menuitem", { name: /feature\/two/ }),
		).toBeVisible();
	},
};

export const Phone: Story = {
	beforeEach: () => {
		sessionViewState.compact = true;
	},
	args: {
		git: {
			branch: "fix/draft-menus",
			worktree: "conduit-wt-draft",
			dirty: true,
		},
	},
};

export const LongNames: Story = {
	args: {
		directory: "/src/spm-architecture-deepening",
		git: { branch: "docs/architecture-deepening-design", dirty: true },
	},
	play: async ({ canvasElement }) => {
		const project = within(canvasElement)
			.getByTestId("session-bar-identity")
			.querySelector('[data-part="project"]');
		expect(project).not.toBeNull();
		if (!project) return;
		expect(project.getBoundingClientRect().width).toBeCloseTo(
			Number.parseFloat(getComputedStyle(project).minWidth),
			0,
		);
	},
};
