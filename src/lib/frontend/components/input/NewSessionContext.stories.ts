import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, userEvent, within } from "storybook/test";
import { discoveryState } from "../../stores/discovery.svelte.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import NewSessionContext from "./NewSessionContext.svelte";

function seed(
	supportsMultiFolder: boolean | undefined,
	folders = 2,
	supportsWorktree = true,
) {
	const previous = {
		instances: instanceState.instances,
		providerCapabilities: instanceState.providerCapabilities,
		projects: projectState.projects,
		path: routerState.path,
		search: routerState.search,
		instance: discoveryState.selectedInstanceId,
		compact: sessionViewState.compact,
	};
	instanceState.instances = [
		{
			id: "folder-provider",
			name: "Folder provider",
			driver: "opencode",
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
			folders: folders === 1 ? ["/src/app"] : ["/src/app", "/src/docs"],
		},
	];
	routerState.path = "/new";
	routerState.search = "?project=workspace";
	discoveryState.selectedInstanceId = "folder-provider";
	sessionViewState.compact = false;
	return () => {
		instanceState.instances = previous.instances;
		instanceState.providerCapabilities = previous.providerCapabilities;
		projectState.projects = previous.projects;
		routerState.path = previous.path;
		routerState.search = previous.search;
		discoveryState.selectedInstanceId = previous.instance;
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
