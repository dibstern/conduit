import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
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
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 0,
			...(supportsMultiFolder !== undefined
				? { capabilities: { supportsMultiFolder, supportsWorktree } }
				: {}),
		},
	];
	instanceState.providerCapabilities = {};
	projectState.projects = [
		{
			slug: "workspace",
			title: "Workspace",
			instanceId: "folder-provider",
			folders: folders === 1 ? ["/src/app"] : ["/src/app", "/src/docs"],
			...(driver === "claude" ? { git: { branch: "main" } } : {}),
		},
	];
	routerState.path = "/new";
	routerState.search = "?project=workspace";
	sessionViewState.compact = false;
	return () => {
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
			"New worktree soon",
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
		await expect(canvas.getByRole("menu")).toHaveTextContent(
			"New worktree soon",
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
	args: { newWorktree: true },
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
		await userEvent.click(
			canvas.getByRole("menuitem", { name: "Existing worktree" }),
		);
		await expect(
			await canvas.findByRole("menuitemradio", { name: /feature\/draft/ }),
		).toHaveTextContent("/src/app-draft");
		await expect(
			canvas.getByRole("menuitemradio", { name: /feature\/docs/ }),
		).toHaveTextContent("/src/docs-draft");
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

export const ExistingWorktreeUnsupported: Story = {
	beforeEach: () => seed(false, 1, false),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement.ownerDocument.body);
		await userEvent.click(canvas.getByTestId("draft-start-chip"));
		await expect(
			canvas.getByRole("menuitem", { name: /Existing worktree/ }),
		).toHaveAttribute("aria-disabled", "true");
		await expect(
			canvas.getByRole("menuitem", { name: /Existing worktree/ }),
		).toHaveTextContent("Not supported by Folder provider");
	},
};
