import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
	type FindFoldersResponse,
	ProjectSaveRejected,
} from "../../../contracts/ws-rpc.js";
import type { FindFoldersRpcInput } from "../../transport/ws-rpc-client.js";
import ProjectDialog from "./ProjectDialog.svelte";

const home = "/Users/dev";
const root = `${home}/src`;
const app = `${root}/conduit`;
const docs = `${root}/conduit-docs`;
const site = `${root}/conduit-site`;
const notes = `${root}/conduit-notes`;
const existing = [app, docs, site, `${app}/packages/sdk`];

async function findFolders({
	query,
}: FindFoldersRpcInput): Promise<FindFoldersResponse> {
	if (!/^[/~]/.test(query)) return { home, entries: [] };
	return {
		home,
		entries: [
			...existing
				.filter((path) => path.startsWith(query))
				.map((path) => ({
					path,
					isGitRepo: true,
					reason: "match" as const,
					exists: true,
				})),
			...(existing.includes(query)
				? []
				: [
						{
							path: query,
							isGitRepo: false,
							reason: "match" as const,
							exists: false,
						},
					]),
		],
	};
}

const suggestions: FindFoldersResponse["entries"] = [
	{ path: app, isGitRepo: true, reason: "recent", exists: true },
	{
		path: "/Users/dev/notes",
		isGitRepo: false,
		reason: "recent",
		exists: true,
	},
	{ path: site, isGitRepo: true, reason: "sibling", exists: true },
	{ path: `${root}/infra`, isGitRepo: true, reason: "sibling", exists: true },
];

const meta = {
	title: "Project/ProjectDialog",
	component: ProjectDialog,
	tags: ["autodocs", "viewport-capture"],
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false } },
		a11y: { test: "error" },
	},
	args: {
		open: true,
		projects: [],
		onclose: fn(),
		onsaved: fn(),
		findFolders,
		saveProject: fn(async () => ({
			savedSlug: "conduit",
			projects: [],
			warnings: [],
		})),
	},
} satisfies Meta<typeof ProjectDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const canvasFor = (canvasElement: HTMLElement) =>
	within(canvasElement.ownerDocument.body);

async function addPath(
	canvasElement: HTMLElement,
	path: string,
): Promise<void> {
	const canvas = canvasFor(canvasElement);
	const input = canvas.getByRole("combobox", { name: "Add folder" });
	await userEvent.clear(input);
	await userEvent.type(input, path);
	await userEvent.click(await canvas.findByRole("option", { name: path }));
}

export const Empty: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await expect(
			canvas.getByRole("dialog", { name: "Add project" }),
		).toBeVisible();
		await expect(
			canvas.getByRole("combobox", { name: "Add folder" }),
		).toHaveFocus();
		await expect(
			canvas.getByRole("button", { name: "Add project" }),
		).toBeDisabled();
		await expect(canvas.getByText("No folders added yet")).toBeVisible();
		await expect(canvas.queryByRole("alert")).toBeNull();
	},
};

export const FolderRepositories: Story = {
	args: {
		project: {
			slug: "conduit",
			title: "Conduit",
			folders: [app, docs, notes],
			repositoryIdentities: {
				[app]: { key: "example.test/team/conduit", name: "Conduit", root: app },
				[docs]: {
					key: "example.test/team/docs",
					name: "Documentation",
					root: docs,
				},
			},
			git: {
				branch: "main",
				folders: [
					{ root: app, label: "conduit", branch: "main", dirty: false },
					{
						root: docs,
						label: "conduit-docs",
						branch: "docs/folders",
						dirty: true,
					},
				],
			},
		},
	},
	play: async ({ canvasElement }) => {
		const rows = canvasFor(canvasElement).getAllByTestId("project-folder-row");
		await expect(rows[0]).toHaveTextContent("Conduit");
		await expect(rows[0]).toHaveTextContent("main");
		await expect(rows[1]).toHaveTextContent("Documentation");
		await expect(rows[1]).toHaveTextContent("docs/folders");
		await expect(rows[2]).toHaveTextContent("Not a git repository");
	},
};

export const PathMatchesOpen: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		const input = canvas.getByRole("combobox", { name: "Add folder" });
		await userEvent.type(input, `${root}/con`);
		const listbox = await canvas.findByRole("listbox", {
			name: "Folder matches",
		});
		await expect(input).toHaveAttribute("aria-expanded", "true");
		await expect(input).toHaveFocus();
		await expect(listbox.id).toBe(input.getAttribute("aria-controls"));
		const options = within(listbox).getAllByRole("option");
		await expect(options[0]).toHaveAttribute("aria-selected", "true");
		await userEvent.keyboard("{ArrowDown}");
		await expect(options[1]).toHaveAttribute("aria-selected", "true");
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			options[1]?.id,
		);
		await expect(
			canvas.getByRole("checkbox", { name: "git init" }),
		).toBeChecked();
	},
};

export const SeveralFolders: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await addPath(canvasElement, app);
		await addPath(canvasElement, docs);
		await addPath(canvasElement, site);
		await userEvent.click(
			canvas.getByRole("button", { name: `Make main: ${docs}` }),
		);
		await expect(
			canvas.getAllByTestId("project-folder-row")[0],
		).toHaveAttribute("aria-label", `Main folder: ${docs}`);
		await expect(
			canvas.getByRole("textbox", { name: "Project name" }),
		).toHaveValue("conduit-docs");
		const name = canvas.getByRole("textbox", { name: "Project name" });
		await userEvent.clear(name);
		await userEvent.type(name, "Conduit workspace");
		await userEvent.click(
			canvas.getByRole("button", { name: `Make main: ${app}` }),
		);
		await expect(name).toHaveValue("Conduit workspace");
		await expect(
			canvas.getByRole("button", { name: "Add project" }),
		).toBeEnabled();
	},
};

export const NewFolder: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await userEvent.type(
			canvas.getByRole("combobox", { name: "Add folder" }),
			notes,
		);
		await canvas.findByRole("option", { name: /New folder/ });
		await expect(
			canvas.getByRole("checkbox", { name: "git init" }),
		).toBeChecked();
		await userEvent.click(canvas.getByRole("option", { name: /New folder/ }));
		await expect(canvas.getByTestId("project-folder-row")).toHaveTextContent(
			"new",
		);
		await expect(
			canvas.getByRole("textbox", { name: "Project name" }),
		).toHaveValue("conduit-notes");
		await expect(canvas.getByText("git init", { exact: true })).toBeVisible();
	},
};

// Adding another project's main folder opens that project, so the clash only
// shows when an edit makes it this project's main folder.
export const Errors: Story = {
	args: {
		project: { slug: "docs", title: "Docs", folders: [docs] },
		projects: [
			{ slug: "conduit", title: "Conduit", folders: [app] },
			{ slug: "docs", title: "Docs", folders: [docs] },
		],
	},
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await addPath(canvasElement, app);
		await userEvent.click(
			canvas.getByRole("button", { name: `Make main: ${app}` }),
		);
		await expect(canvas.getByRole("alert")).toHaveTextContent(
			"already the main folder",
		);
		await expect(canvas.getByRole("link", { name: "Conduit" })).toHaveAttribute(
			"href",
			"/?p=conduit",
		);
		await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled();
	},
};

export const Warnings: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await addPath(canvasElement, app);
		await addPath(canvasElement, `${app}/packages/sdk`);
		await expect(canvas.getByRole("status")).toHaveTextContent("is inside");
		await expect(
			canvas.getByRole("button", { name: "Add project" }),
		).toBeEnabled();
	},
};

export const DuplicateFolder: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await addPath(canvasElement, app);
		await addPath(canvasElement, app);
		await expect(canvas.getByRole("alert")).toHaveTextContent("already added");
		await expect(canvas.getAllByTestId("project-folder-row")).toHaveLength(1);
	},
};

export const DiskError: Story = {
	args: {
		saveProject: fn(async () =>
			Promise.reject(
				new ProjectSaveRejected({
					issues: [
						{ kind: "mkdir-failed", path: notes, message: "Permission denied" },
					],
				}),
			),
		),
	},
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await userEvent.type(
			canvas.getByRole("combobox", { name: "Add folder" }),
			notes,
		);
		await userEvent.click(
			await canvas.findByRole("option", { name: /New folder/ }),
		);
		await userEvent.click(canvas.getByRole("button", { name: "Add project" }));
		await expect(await canvas.findByRole("alert")).toHaveTextContent(
			"Permission denied",
		);
		await expect(canvas.getByTestId("project-folder-row")).toBeVisible();
	},
};

export const KeyboardSave: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = canvasFor(canvasElement);
		const input = canvas.getByRole("combobox", { name: "Add folder" });
		await userEvent.type(input, notes);
		await canvas.findByRole("option", { name: /New folder/ });
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveFocus();
		await userEvent.type(input, docs);
		await canvas.findByRole("option", { name: docs });
		await userEvent.keyboard("{Enter}");
		await userEvent.keyboard("{Tab}{Tab}");
		await expect(
			canvas.getByRole("button", { name: `Make main: ${docs}` }),
		).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveFocus();
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		await expect(args["saveProject"]).toHaveBeenCalledWith({
			title: "conduit-docs",
			folders: [docs, { path: notes, create: { gitInit: true } }],
			groupingMode: null,
		});
	},
};

export const SuggestionsOpen: Story = {
	args: {
		findFolders: async ({ query }: FindFoldersRpcInput) => ({
			home,
			entries: suggestions.filter((entry) =>
				entry.path.toLowerCase().includes(query.toLowerCase()),
			),
		}),
	},
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		const group = await canvas.findByRole("group", { name: "Suggestions" });
		await expect(
			canvas.getByRole("combobox", { name: "Add folder" }),
		).toHaveAttribute("aria-expanded", "true");
		const option = (path: string) =>
			within(group).getByRole("option", { name: path });
		await expect(option(app)).toHaveTextContent("recent · git");
		await expect(option("/Users/dev/notes")).toHaveTextContent(/recent$/);
		await expect(option(site)).toHaveTextContent(/git$/);
		await expect(option(site)).not.toHaveTextContent("recent");
		await userEvent.click(option(site));
		await expect(canvas.getByTestId("project-folder-row")).toHaveAttribute(
			"aria-label",
			`Main folder: ${site}`,
		);
		await expect(
			within(group).queryByRole("option", { name: site }),
		).toBeNull();
		await expect(within(group).getAllByRole("option")).toHaveLength(3);
	},
};

const editedProject = {
	slug: "conduit",
	title: "Conduit",
	folders: [app, docs] as const,
};

const capabilityInstances = [
	{
		id: "all-folders",
		name: "Folder provider",
		capabilities: { supportsMultiFolder: true, supportsWorktree: true },
	},
	{
		id: "main-only",
		name: "Main provider",
		capabilities: { supportsMultiFolder: false, supportsWorktree: false },
	},
];

export const MultiFolderProviderSupport: Story = {
	args: { project: editedProject, instances: capabilityInstances },
	play: async ({ canvasElement }) => {
		const support = canvasFor(canvasElement).getByTestId(
			"project-provider-capabilities",
		);
		await expect(support).toHaveTextContent(
			/^Main provider works in the main folder only\.$/,
		);
	},
};

export const MultiFolderSupported: Story = {
	args: { project: editedProject, instances: capabilityInstances.slice(0, 1) },
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await expect(
			canvas.queryByTestId("project-provider-capabilities"),
		).toBeNull();
		await expect(
			canvas.getByText("Folders · Sessions run in main and can edit all"),
		).toBeVisible();
	},
};

export const MultiFolderUnknown: Story = {
	args: {
		project: editedProject,
		instances: [{ id: "unknown", name: "Unknown provider" }],
	},
	play: async ({ canvasElement }) => {
		await expect(
			canvasFor(canvasElement).queryByTestId("project-provider-capabilities"),
		).toBeNull();
	},
};

export const SingleFolderProviderSupport: Story = {
	args: {
		project: { ...editedProject, folders: [app] },
		instances: capabilityInstances,
	},
	play: async ({ canvasElement }) => {
		await expect(
			canvasFor(canvasElement).queryByTestId("project-provider-capabilities"),
		).toBeNull();
	},
};

export const Edit: Story = {
	args: {
		project: editedProject,
		projects: [editedProject],
	},
	play: async ({ canvasElement, args }) => {
		const canvas = canvasFor(canvasElement);
		await expect(
			canvas.getByRole("dialog", { name: "Edit project" }),
		).toBeVisible();
		await expect(
			canvas
				.getAllByTestId("project-folder-row")
				.map((row) => row.getAttribute("aria-label")),
		).toEqual([`Main folder: ${app}`, `Extra folder: ${docs}`]);
		const name = canvas.getByRole("textbox", { name: "Project name" });
		await expect(name).toHaveValue("Conduit");
		const save = canvas.getByRole("button", { name: "Save" });
		await expect(save).toBeDisabled();
		await expect(canvas.queryByRole("alert")).toBeNull();
		await userEvent.type(
			canvas.getByRole("combobox", { name: "Add folder" }),
			notes,
		);
		await userEvent.click(
			await canvas.findByRole("option", { name: /New folder/ }),
		);
		await expect(save).toBeEnabled();
		await userEvent.click(
			canvas.getByRole("button", { name: `Remove folder: ${notes}` }),
		);
		await expect(save).toBeDisabled();
		await userEvent.click(
			canvas.getByRole("button", { name: `Make main: ${docs}` }),
		);
		await expect(name).toHaveValue("Conduit");
		await userEvent.click(save);
		await expect(args["saveProject"]).toHaveBeenCalledWith({
			slug: "conduit",
			title: "Conduit",
			folders: [docs, app],
			groupingMode: null,
		});
	},
};

export const WithSetupScript: Story = {
	args: {
		project: {
			...editedProject,
			setupScript: "pnpm install\nprintf 'Workspace ready\\n'",
		},
		projects: [editedProject],
	},
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await expect(
			canvas.getByRole("textbox", { name: /^Setup script$/ }),
		).toHaveValue("pnpm install\nprintf 'Workspace ready\\n'");
		await expect(
			canvas.getByText("It runs in each new worktree before the agent starts."),
		).toBeVisible();
	},
};

export const RepositoryGroupingOverride: Story = {
	args: {
		project: {
			...editedProject,
			groupingMode: "repository+subfolder",
		},
		projects: [editedProject],
	},
	play: async ({ canvasElement, args }) => {
		const canvas = canvasFor(canvasElement);
		const grouping = canvas.getByRole("combobox", {
			name: "Repository grouping",
		});
		await expect(grouping).toHaveValue("repository+subfolder");
		await expect(within(grouping).getAllByRole("option")).toHaveLength(4);
		await expect(
			within(grouping).getByRole("option", { name: "Use global default" }),
		).toHaveValue("");
		await expect(
			within(grouping).getByRole("option", {
				name: /^By repository$/,
			}),
		).toHaveValue("repository");
		await expect(
			within(grouping).getByRole("option", {
				name: "By repository and subfolder",
			}),
		).toHaveValue("repository+subfolder");
		await expect(
			within(grouping).getByRole("option", { name: "Off" }),
		).toHaveValue("off");
		const save = canvas.getByRole("button", { name: "Save" });
		await expect(save).toBeDisabled();
		await userEvent.selectOptions(grouping, "off");
		await expect(save).toBeEnabled();
		await userEvent.click(save);
		await expect(args["saveProject"]).toHaveBeenCalledWith({
			slug: "conduit",
			title: "Conduit",
			folders: [app, docs],
			groupingMode: "off",
		});
		await userEvent.selectOptions(grouping, "repository+subfolder");
		await expect(grouping).toHaveValue("repository+subfolder");
	},
};
