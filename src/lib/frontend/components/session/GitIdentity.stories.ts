import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import AgentWorktreeLifecycle from "./__fixtures__/AgentWorktreeLifecycle.svelte";
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

export const FolderDetailsOpen: Story = {
	tags: ["viewport-capture"],
	args: {
		git: {
			branch: "feature/web",
			dirty: false,
			folders: [
				{
					root: "/src/conduit",
					label: "conduit",
					branch: "feature/web",
					dirty: false,
					ahead: 0,
					behind: 0,
				},
				{
					root: "/src/api",
					label: "api",
					branch: "feature/api",
					dirty: true,
					ahead: 2,
					behind: 1,
				},
				{
					root: "/src/library",
					label: "library",
					head: "a1b2c3d",
					dirty: false,
				},
			],
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-identity"),
		);
		const rows = within(canvasElement.ownerDocument.body).getAllByTestId(
			"session-folder-git",
		);
		await expect(rows).toHaveLength(3);
		await expect(rows[0]).toHaveTextContent("feature/web");
		await expect(rows[0]).toHaveTextContent("clean");
		await expect(rows[1]).toHaveTextContent("feature/api");
		await expect(rows[1]).toHaveTextContent("uncommitted");
		await expect(rows[1]).toHaveTextContent("↑2 ↓1");
		await expect(rows[2]).toHaveTextContent("Detached at a1b2c3d");
	},
};

export const NonGitPrimary: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/notes",
		git: {
			folders: [
				{
					root: "/src/api",
					label: "api",
					branch: "feature/api",
					dirty: true,
					ahead: 2,
					behind: 1,
				},
			],
		},
	},
	play: async ({ canvasElement }) => {
		const identity = within(canvasElement).getByTestId("session-bar-identity");
		await expect(
			identity.querySelector('[data-icon="folder"]'),
		).toBeInTheDocument();
		await userEvent.click(identity);
		const rows = within(canvasElement.ownerDocument.body).getAllByTestId(
			"session-folder-git",
		);
		await expect(rows).toHaveLength(1);
		await expect(rows[0]).toHaveTextContent("api");
		await expect(rows[0]).toHaveTextContent("feature/api");
		await expect(rows[0]).toHaveTextContent("uncommitted");
		await expect(rows[0]).toHaveTextContent("↑2 ↓1");
	},
};

export const SharedFolderDetailsOpen: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/conduit/worktrees/workspace/session/app",
		git: {
			branch: "conduit/session-cross-repo",
			worktree: "app",
			folders: [
				{
					root: "/src/app",
					label: "app",
					branch: "conduit/session-cross-repo",
					worktree: "app",
					dirty: false,
				},
				{
					root: "/src/api",
					label: "api",
					branch: "conduit/session-cross-repo",
					worktree: "api",
					dirty: true,
				},
				{ root: "/src/notes", label: "notes", shared: true },
				{
					root: "/src/library",
					label: "library",
					branch: "main",
					dirty: false,
					shared: true,
				},
			],
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-identity"),
		);
		const rows = within(canvasElement.ownerDocument.body).getAllByTestId(
			"session-folder-git",
		);
		const notes = within(canvasElement.ownerDocument.body).getByRole("region", {
			name: "notes",
		});
		const library = within(canvasElement.ownerDocument.body).getByRole(
			"region",
			{ name: "library" },
		);
		await expect(rows).toHaveLength(4);
		await expect(rows[0]).toHaveTextContent("conduit/session-cross-repo");
		await expect(rows[1]).toHaveTextContent("conduit/session-cross-repo");
		await expect(
			within(notes).getByText("shared", { exact: true }),
		).toBeVisible();
		await expect(notes).not.toHaveTextContent(/Detached|Branch|Changes|clean/);
		await expect(
			within(library).getByText("shared", { exact: true }),
		).toBeVisible();
		await expect(library).toHaveTextContent("main");
		await expect(library).toHaveTextContent("clean");
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

export const WorkspaceMismatch: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit-two",
		git: { branch: "feature/two", worktree: "conduit-two" },
		workspaceMismatch: {
			actualPath: "/src/conduit/.claude/worktrees/contract",
		},
		onmove: fn(async (_path: string) => {}),
	},
	play: async ({ canvasElement, args }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-identity"),
		);
		const body = within(canvasElement.ownerDocument.body);
		await expect(body.getByTestId("workspace-mismatch")).toHaveTextContent(
			args["workspaceMismatch"]?.actualPath ?? "",
		);
		await userEvent.click(body.getByRole("menuitem", { name: "Retry move" }));
		await expect(args["onmove"]).toHaveBeenCalledWith("/src/conduit-two");
		await userEvent.click(
			within(canvasElement).getByTestId("session-bar-identity"),
		);
		await expect(body.getByTestId("workspace-mismatch")).toBeVisible();
	},
};

export const MovedBack: Story = {
	tags: ["viewport-capture"],
	args: {
		git: { branch: "main" },
		workspaceCause: "missing",
	},
	play: async ({ canvasElement }) => {
		await expect(
			within(canvasElement).getByTestId("workspace-moved-back"),
		).toHaveTextContent("moved back: worktree removed");
	},
};

export const MovedBackPhone: Story = {
	...MovedBack,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const notice = canvas.getByTestId("workspace-moved-back");
		await expect(notice).toHaveAttribute("role", "img");
		await expect(notice).toHaveAttribute(
			"aria-label",
			"moved back: worktree removed",
		);
		await expect(notice).toHaveTextContent(/^$/);
		await expect(
			canvas.getByTestId("session-bar-identity"),
		).toHaveAccessibleName(/moved back: worktree removed/);
	},
};

export const WorkspaceHint: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit",
		git: { branch: "main" },
		workspaceHint: "/src/conduit-hint",
		onmove: fn(async (_path: string) => {}),
		ondismiss: fn(async (_path: string) => {}),
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("workspace-hint")).toHaveTextContent(
			"working in conduit-hint?",
		);
		await userEvent.click(canvas.getByTestId("workspace-hint-move"));
		await expect(args["onmove"]).toHaveBeenCalledWith("/src/conduit-hint");
		await userEvent.click(canvas.getByTestId("workspace-hint-dismiss"));
		await expect(args["ondismiss"]).toHaveBeenCalledWith("/src/conduit-hint");
	},
};

export const WorkspaceHintPhone: Story = {
	...WorkspaceHint,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const hint = canvas.getByTestId("workspace-hint");
		await expect(hint).toHaveAttribute(
			"aria-label",
			"working in conduit-hint?",
		);
		await expect(hint).toHaveTextContent(/^$/);
		await expect(
			canvas.queryByTestId("workspace-hint-move"),
		).not.toBeInTheDocument();
		await expect(
			canvas.queryByTestId("workspace-hint-dismiss"),
		).not.toBeInTheDocument();
		const identity = canvas.getByTestId("session-bar-identity");
		await userEvent.click(identity);
		await expect(body.getByTestId("workspace-hint-dismiss")).toBeVisible();
		await userEvent.click(body.getByTestId("workspace-hint-move"));
		await expect(args["onmove"]).toHaveBeenCalledWith("/src/conduit-hint");
		await userEvent.click(identity);
		await userEvent.click(body.getByTestId("workspace-hint-dismiss"));
		await expect(args["ondismiss"]).toHaveBeenCalledWith("/src/conduit-hint");
	},
};

async function playAgentMove(canvasElement: HTMLElement, exit: boolean) {
	const canvas = within(canvasElement);
	const body = within(canvasElement.ownerDocument.body);
	const identity = canvas.getByTestId("session-bar-identity");
	await expect(identity).toHaveAttribute("title", "conduit / main");
	await userEvent.click(canvas.getByRole("button", { name: "EnterWorktree" }));
	await waitFor(() =>
		expect(identity).toHaveAttribute(
			"title",
			"header-agent / worktree-header-agent",
		),
	);
	await expect(
		identity.querySelector('[data-icon="worktree"]'),
	).toBeInTheDocument();
	await expect(canvas.getByTestId("agent-worktree-status")).toHaveTextContent(
		"Session header · Running turn",
	);
	await userEvent.click(identity);
	let menu = await body.findByRole("menu", { name: "Checkout" });
	await expect(
		within(menu).getByText("/src/conduit/.claude/worktrees/header-agent", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		within(menu).getByText("Worktree", { exact: true }),
	).toBeVisible();
	if (!exit) return;
	await userEvent.keyboard("{Escape}");
	await waitFor(() => expect(menu).not.toBeVisible());
	await userEvent.click(canvas.getByRole("button", { name: "ExitWorktree" }));
	await waitFor(() =>
		expect(identity).toHaveAttribute("title", "conduit / main"),
	);
	await expect(
		identity.querySelector('[data-icon="branch"]'),
	).toBeInTheDocument();
	await expect(
		identity.querySelector('[data-part="worktree"]'),
	).not.toBeInTheDocument();
	await expect(canvas.getByTestId("agent-worktree-status")).toHaveTextContent(
		"Session header · Running turn",
	);
	await userEvent.click(identity);
	menu = await body.findByRole("menu", { name: "Checkout" });
	await expect(
		within(menu).getByText("/src/conduit", { exact: true }),
	).toBeVisible();
	await expect(
		within(menu).queryByText("Worktree", { exact: true }),
	).not.toBeInTheDocument();
}

export const AgentEntersWorktree: Story = {
	tags: ["viewport-capture"],
	args: { git: { branch: "main", dirty: false, ahead: 0, behind: 0 } },
	render: (args) => ({ Component: AgentWorktreeLifecycle, props: args }),
	play: async ({ canvasElement }) => playAgentMove(canvasElement, false),
};

export const AgentExitsWorktree: Story = {
	...AgentEntersWorktree,
	// Storybook indexes tags statically, so a spread one is not seen.
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => playAgentMove(canvasElement, true),
};

export const PhoneAgentEntersWorktree: Story = {
	...AgentEntersWorktree,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
};

export const PhoneAgentExitsWorktree: Story = {
	...AgentExitsWorktree,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
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
