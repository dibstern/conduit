import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import {
	clearDraftSelection,
	selectInstance,
} from "../../stores/discovery.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import NewSessionContext from "./NewSessionContext.svelte";

function seed(
	supportsMultiFolder: boolean | undefined,
	folders = 2,
	supportsWorktree = true,
	driver: "claude" | "opencode" = "opencode",
	supportsNewWorktree = supportsWorktree,
) {
	const previous = {
		instances: instanceState.instances,
		providerCapabilities: instanceState.providerCapabilities,
		projects: projectState.projects,
		path: routerState.path,
		search: routerState.search,
		compact: sessionViewState.compact,
	};
	instanceState.instances = [
		{
			id: "folder-provider",
			name: "Folder provider",
			driver,
			isDefault: true,
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 0,
			...(supportsMultiFolder !== undefined
				? {
						capabilities: {
							supportsMultiFolder,
							supportsWorktree,
							supportsNewWorktree,
						},
					}
				: {}),
		},
	];
	instanceState.providerCapabilities = {};
	selectInstance("folder-provider");
	projectState.projects = [
		{
			slug: "workspace",
			title: "Workspace",
			folders: folders === 1 ? ["/src/app"] : ["/src/app", "/src/docs"],
			...(driver === "claude" ? { git: { branch: "main" } } : {}),
		},
	];
	routerState.path = "/new";
	routerState.search = "?project=workspace";
	sessionViewState.compact = false;
	return () => {
		clearDraftSelection();
		instanceState.instances = previous.instances;
		instanceState.providerCapabilities = previous.providerCapabilities;
		projectState.projects = previous.projects;
		routerState.path = previous.path;
		routerState.search = previous.search;
		sessionViewState.compact = previous.compact;
	};
}

const meta = {
	title: "Input/NewSessionContext",
	component: NewSessionContext,
	tags: ["autodocs", "viewport-capture"],
	parameters: { layout: "padded", a11y: { test: "error" } },
	args: { sessionModeDefault: { mode: "local", source: "global" } },
} satisfies Meta<typeof NewSessionContext>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SingleFolder: Story = {
	beforeEach: () => seed(false, 1, false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^Current folder$/,
		);
		await expect(canvas.queryByTestId("draft-provider-explanation")).toBeNull();
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		await expect(canvas.getByRole("menu")).toHaveTextContent(
			"New worktree Not supported by Folder provider",
		);
		const existing = canvas.getByRole("menuitem", {
			name: /Existing worktree/,
		});
		await expect(existing).toHaveAttribute("aria-disabled", "true");
		await expect(existing).toHaveTextContent(
			"Not supported by Folder provider",
		);
	},
};

export const MultiFolderSupported: Story = {
	beforeEach: () => seed(true),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const startChip = canvas.getByTestId("draft-start-chip");
		await expect(startChip).toHaveTextContent(/^Current folder$/);
		await expect(startChip).not.toHaveAttribute("aria-describedby");
		await expect(canvas.queryByTestId("draft-provider-explanation")).toBeNull();
		await userEvent.click(startChip);
		await expect(canvas.getByRole("menu")).toHaveTextContent(
			"New worktree Requires a Git folder",
		);
		await expect(canvas.queryByText("Provider folder support")).toBeNull();
	},
};

export const MultiFolderUnsupported: Story = {
	beforeEach: () => seed(false, 2, false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const startChip = canvas.getByTestId("draft-start-chip");
		const explanation = canvas.getByTestId("draft-provider-explanation");
		await expect(startChip).toHaveTextContent(/^Current folder$/);
		await expect(explanation).toHaveTextContent(
			/^Folder provider works in the main folder only\. Pick another provider to use every folder\.$/,
		);
		await expect(startChip).toHaveAttribute("aria-describedby", explanation.id);
		await userEvent.click(startChip);
		await expect(canvas.getByRole("menu")).toHaveTextContent(
			"Not supported by Folder provider",
		);
		await expect(canvas.queryByText("Provider folder support")).toBeNull();
	},
};

export const MultiFolderUnknown: Story = {
	beforeEach: () => seed(undefined),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		const startChip = canvas.getByTestId("draft-start-chip");
		await expect(startChip).toHaveTextContent(/^Current folder$/);
		await expect(startChip).not.toHaveAttribute("aria-describedby");
		await expect(canvas.queryByTestId("draft-provider-explanation")).toBeNull();
		await userEvent.click(startChip);
		// An account that reports nothing gets its driver's capabilities, and
		// OpenCode can start a new worktree.
		await expect(canvas.getByRole("menu")).toHaveTextContent(
			"New worktree Requires a Git folder",
		);
	},
};

export const NewWorktreeEnabled: Story = {
	beforeEach: () => seed(true, 1, true, "claude"),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		const choice = canvas.getByRole("menuitem", {
			name: /^New worktree$/,
		});
		await expect(choice).not.toHaveAttribute("aria-disabled", "true");
		await userEvent.click(choice);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^New worktree$/,
		);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		await userEvent.click(
			canvas.getByRole("menuitemradio", { name: "Current checkout" }),
		);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^main$/,
		);
	},
};

export const NewWorktreeSelected: Story = {
	beforeEach: () => seed(true, 1, true, "claude"),
	args: { newWorktree: true, modeChosen: true },
};

export const DefaultedWorktree: Story = {
	beforeEach: () => {
		const cleanup = seed(true, 1, true, "claude");
		projectState.projects = projectState.projects.map((project) => ({
			...project,
			title: "Isolated by default",
			git: { branch: "release/session-defaults" },
		}));
		return cleanup;
	},
	args: { sessionModeDefault: { mode: "worktree", source: "file" } },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(
			await canvas.findByTestId("draft-start-chip"),
		).toHaveTextContent(/^New worktree$/);
		await expect(
			canvas.getByTestId("draft-base-branch-chip"),
		).toHaveTextContent(/^from release\/session-defaults$/);
		await expect(canvas.queryByTestId("draft-session-mode-warning")).toBeNull();
	},
};

export const SessionModeWarning: Story = {
	beforeEach: () => seed(true, 1, true, "claude"),
	args: {
		sessionModeDefault: {
			mode: "local",
			source: "global",
			warning: "Invalid conduit.json: sessionMode must be local or worktree",
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(
			await canvas.findByTestId("draft-session-mode-warning"),
		).toHaveTextContent("Invalid conduit.json");
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^main$/,
		);
	},
};

export const OpenCodeNewWorktreeEnabled: Story = {
	beforeEach: () => {
		const cleanup = seed(true, 1, false, "opencode", true);
		projectState.projects = projectState.projects.map((project) => ({
			...project,
			title: "OpenCode workspace",
			git: { branch: "feature/opencode-workspace" },
		}));
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		await expect(
			canvas.getByRole("menuitem", { name: /^Existing worktree/ }),
		).toHaveAttribute("aria-disabled", "true");
		const choice = canvas.getByRole("menuitem", { name: /^New worktree$/ });
		await expect(choice).not.toHaveAttribute("aria-disabled", "true");
		await userEvent.click(choice);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^New worktree$/,
		);
		await expect(
			canvas.getByTestId("draft-base-branch-chip"),
		).toHaveTextContent(/^from feature\/opencode-workspace$/);
	},
};

export const NewWorktreeUnsupportedProvider: Story = {
	beforeEach: () => {
		const cleanup = seed(true, 1, false, "opencode");
		instanceState.instances = instanceState.instances.map((instance) => ({
			...instance,
			name: "Local provider",
		}));
		projectState.projects = projectState.projects.map((project) => ({
			...project,
			title: "Local workspace",
			git: { branch: "main" },
		}));
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		for (const label of ["New worktree", "Existing worktree"]) {
			const choice = canvas.getByRole("menuitem", {
				name: new RegExp(`^${label}`),
			});
			await expect(choice).toHaveAttribute("aria-disabled", "true");
			await expect(choice).toHaveTextContent(
				`${label} Not supported by Local provider`,
			);
		}
	},
};

export const BaseBranchDefault: Story = {
	beforeEach: () => {
		const cleanup = seed(true, 1, true, "claude");
		projectState.projects = projectState.projects.map((project) => ({
			...project,
			git: { branch: "feature/session-ui" },
		}));
		return cleanup;
	},
	args: { newWorktree: true, modeChosen: true },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(
			canvas.getByTestId("draft-base-branch-chip"),
		).toHaveTextContent(/^from feature\/session-ui$/);
		await expect(canvas.queryByRole("menu")).toBeNull();
	},
};

export const BaseBranchList: Story = {
	beforeEach: () => seed(true, 1, true, "claude"),
	args: {
		newWorktree: true,
		modeChosen: true,
		loadBranches: async () => ({
			current: "main",
			branches: ["feature/session-ui", "main", "release"],
		}),
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-base-branch-chip"));
		await expect(
			await canvas.findByRole("menuitemradio", { name: "main" }),
		).toHaveAttribute("aria-checked", "true");
		await expect(
			canvas.getByRole("menuitemradio", {
				name: "feature/session-ui",
			}),
		).toHaveAttribute("aria-checked", "false");
		await expect(
			canvas.getByRole("menuitemradio", { name: "release" }),
		).toBeVisible();
	},
};

export const MultiFolderNewWorktree: Story = {
	beforeEach: () => {
		const cleanup = seed(true, 2, true, "claude");
		projectState.projects = [
			{
				slug: "workspace",
				title: "Workspace",
				folders: ["/src/notes", "/src/app", "/src/api"],
				git: {
					folders: [
						{ root: "/src/app", label: "app", branch: "main" },
						{ root: "/src/api", label: "api", branch: "main" },
					],
				},
			},
		];
		return cleanup;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^Current folder$/,
		);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		const choice = canvas.getByRole("menuitem", { name: /^New worktree$/ });
		await expect(choice).not.toHaveAttribute("aria-disabled", "true");
		await userEvent.click(choice);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^New worktree$/,
		);
		await expect(canvas.getByTestId("new-session-context")).toHaveTextContent(
			"from committed HEAD",
		);
	},
};

const existingWorktrees = [
	{ path: "/src/app", branch: "main", main: true },
	{ path: "/src/app-draft", branch: "feature/draft", main: false },
	{ path: "/src/docs-draft", branch: "feature/docs", main: false },
];

export const ExistingWorktreeList: Story = {
	beforeEach: () => seed(true),
	args: { loadWorktrees: async () => ({ worktrees: existingWorktrees }) },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		const existing = canvas.getByRole("menuitem", {
			name: "Existing worktree",
		});
		await userEvent.click(existing);
		await expect(
			await canvas.findByRole("menuitemradio", { name: /feature\/draft/ }),
		).toHaveTextContent("/src/app-draft");
		await expect(
			canvas.getByRole("menuitemradio", { name: /feature\/docs/ }),
		).toHaveTextContent("/src/docs-draft");
		// Keep focus on the command after its asynchronous choices register.
		existing.focus();
		await expect(existing).toHaveFocus();
	},
};

export const ExistingWorktreeSelected: Story = {
	beforeEach: () => seed(true),
	args: { loadWorktrees: async () => ({ worktrees: existingWorktrees }) },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		await userEvent.click(
			canvas.getByRole("menuitem", { name: "Existing worktree" }),
		);
		await userEvent.click(
			await canvas.findByRole("menuitemradio", { name: /feature\/draft/ }),
		);
		await expect(canvas.getByTestId("draft-start-chip")).toHaveTextContent(
			/^feature\/draft$/,
		);
		await expect(canvas.getByTestId("new-session-context")).toHaveTextContent(
			"existing worktree",
		);
	},
};
