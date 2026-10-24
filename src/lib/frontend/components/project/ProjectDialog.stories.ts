import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { Rpc } from "effect/rpc";
import { expect, fn, userEvent, within } from "storybook/test";
import {
	type FindFolders,
	type FindFoldersResponse,
	ProjectSaveRejected,
} from "../../../contracts/ws-rpc.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
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
}: Rpc.PayloadConstructor<typeof FindFolders>): Promise<FindFoldersResponse> {
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
	beforeEach: () => {
		const compact = sessionViewState.compact;
		sessionViewState.compact = window.innerWidth < 768;
		return () => {
			sessionViewState.compact = compact;
		};
	},
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

async function tickPath(
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
			canvas.getByRole("dialog", { name: "Add a project" }),
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
		const rows = canvasFor(canvasElement).getAllByTestId("project-folder-chip");
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
		await expect(options[0]).toHaveAttribute("aria-selected", "false");
		await expect(input).toHaveAttribute(
			"aria-activedescendant",
			options[0]?.id,
		);
		await userEvent.keyboard("{ArrowDown}");
		await expect(options[1]).toHaveAttribute("aria-selected", "false");
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
		await tickPath(canvasElement, app);
		await tickPath(canvasElement, docs);
		await tickPath(canvasElement, site);
		await userEvent.click(
			canvas.getByRole("button", { name: `Make main: ${docs}` }),
		);
		await expect(
			canvas.getAllByTestId("project-folder-chip")[0],
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
		await expect(canvas.getByTestId("project-folder-chip")).toHaveTextContent(
			"new",
		);
		await expect(
			canvas.getByRole("textbox", { name: "Project name" }),
		).toHaveValue("conduit-notes");
		await expect(
			within(canvas.getByTestId("project-folder-chip")).getByText("git init", {
				exact: true,
			}),
		).toBeVisible();
	},
};

export const NewFolderWithoutGit: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = canvasFor(canvasElement);
		const input = canvas.getByRole("combobox", { name: "Add folder" });
		await userEvent.type(input, notes);
		const row = await canvas.findByRole("option", { name: /New folder/ });
		await userEvent.click(canvas.getByRole("checkbox", { name: "git init" }));
		await userEvent.click(row);
		await expect(input).toHaveValue(notes);
		await expect(row).toHaveAttribute("aria-selected", "true");
		await expect(
			canvas.queryByRole("checkbox", { name: "git init" }),
		).toBeNull();
		await expect(
			canvas.getByTestId("project-folder-chip"),
		).not.toHaveTextContent("git init");
		await userEvent.click(row);
		await expect(
			canvas.getByRole("checkbox", { name: "git init" }),
		).not.toBeChecked();
		await userEvent.click(row);
		await userEvent.click(canvas.getByRole("button", { name: "Add project" }));
		await expect(args["saveProject"]).toHaveBeenCalledWith({
			title: "conduit-notes",
			folders: [{ path: notes, create: { gitInit: false } }],
		});
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
		await tickPath(canvasElement, app);
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
		await tickPath(canvasElement, app);
		await tickPath(canvasElement, `${app}/packages/sdk`);
		await expect(canvas.getByRole("status")).toHaveTextContent("is inside");
		await expect(
			canvas.getByRole("button", { name: "Add project" }),
		).toBeEnabled();
	},
};

export const UntickRow: Story = {
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await tickPath(canvasElement, app);
		await tickPath(canvasElement, app);
		await expect(canvas.queryByRole("alert")).toBeNull();
		await expect(canvas.queryAllByTestId("project-folder-chip")).toHaveLength(
			0,
		);
		await expect(canvas.getByRole("option", { name: app })).toHaveAttribute(
			"aria-selected",
			"false",
		);
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
		await expect(canvas.getByTestId("project-folder-chip")).toBeVisible();
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
		await userEvent.clear(input);
		await userEvent.type(input, docs);
		await canvas.findByRole("option", { name: docs });
		await userEvent.keyboard("{Enter}");
		// The phone sheet pins the chips below the form, so the Tab count differs by layout.
		const makeMain = canvas.getByRole("button", { name: `Make main: ${docs}` });
		for (
			let step = 0;
			step < 12 && document.activeElement !== makeMain;
			step++
		) {
			await userEvent.tab();
		}
		await expect(makeMain).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveFocus();
		await userEvent.keyboard("{Control>}{Enter}{/Control}");
		await expect(args["saveProject"]).toHaveBeenCalledWith({
			title: "conduit-docs",
			folders: [docs, { path: notes, create: { gitInit: true } }],
		});
	},
};

const suggestionArgs = {
	findFolders: async ({
		query,
	}: Rpc.PayloadConstructor<typeof FindFolders>) => ({
		home,
		entries: suggestions.filter((entry) =>
			entry.path.toLowerCase().includes(query.toLowerCase()),
		),
	}),
};

export const SuggestionsOpen: Story = {
	args: suggestionArgs,
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		const recent = await canvas.findByRole("group", { name: "Recent" });
		const nearby = canvas.getByRole("group", { name: "Repositories nearby" });
		await expect(within(recent).getAllByRole("option")).toHaveLength(2);
		await expect(within(nearby).getAllByRole("option")).toHaveLength(2);
		await expect(
			within(recent).getByRole("option", { name: app }),
		).toHaveTextContent("git");
		await expect(
			within(recent).getByRole("option", {
				name: "/Users/dev/notes",
			}),
		).not.toHaveTextContent("git");
		const row = within(nearby).getByRole("option", {
			name: site,
		});
		await userEvent.click(row);
		await expect(row).toBeVisible();
		await expect(row).toHaveAttribute("aria-selected", "true");
		await expect(canvas.getByTestId("project-folder-chip")).toHaveAttribute(
			"aria-label",
			`Main folder: ${site}`,
		);
		await expect(
			within(
				canvas.getByRole("listbox", { name: "Folder matches" }),
			).getAllByRole("option"),
		).toHaveLength(4);
	},
};

export const TickedFolders: Story = {
	args: suggestionArgs,
	play: async ({ canvasElement, args }) => {
		const canvas = canvasFor(canvasElement);
		await userEvent.click(await canvas.findByRole("option", { name: site }));
		await userEvent.click(canvas.getByRole("option", { name: app }));
		const chips = canvas.getAllByTestId("project-folder-chip");
		await expect(chips.map((chip) => chip.getAttribute("data-path"))).toEqual([
			site,
			app,
		]);
		await expect(
			within(canvas.getByLabelText(`Main folder: ${site}`)).getByText("Main"),
		).toBeVisible();
		await expect(
			within(canvas.getByLabelText(`Extra folder: ${app}`)).queryByText("Main"),
		).toBeNull();
		await userEvent.click(canvas.getByRole("button", { name: "Add project" }));
		await expect(args["saveProject"]).toHaveBeenCalledTimes(1);
		await expect(args["saveProject"]).toHaveBeenCalledWith({
			title: "conduit-site",
			folders: [site, app],
		});
	},
};

export const TickedFilteredList: Story = {
	args: suggestionArgs,
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		const input = canvas.getByRole("combobox", { name: "Add folder" });
		await userEvent.type(input, "conduit-site");
		const row = await canvas.findByRole("option", {
			name: site,
		});
		await userEvent.keyboard("{Enter}");
		await expect(input).toHaveValue("conduit-site");
		await expect(input).toHaveFocus();
		await expect(row).toHaveAttribute("aria-selected", "true");
		await expect(
			within(
				canvas.getByRole("listbox", { name: "Folder matches" }),
			).getAllByRole("option"),
		).toHaveLength(1);
		await expect(canvas.getByTestId("project-folder-chip")).toHaveAttribute(
			"data-path",
			site,
		);
	},
};

export const UntickByChipRemoval: Story = {
	args: suggestionArgs,
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		const appRow = await canvas.findByRole("option", {
			name: app,
		});
		await userEvent.click(appRow);
		await userEvent.click(canvas.getByRole("option", { name: site }));
		await userEvent.click(
			canvas.getByRole("option", { name: "/Users/dev/notes" }),
		);
		await userEvent.click(
			canvas.getByRole("button", { name: `Remove folder: ${app}` }),
		);
		await expect(appRow).toHaveAttribute("aria-selected", "false");
		const chips = canvas.getAllByTestId("project-folder-chip");
		await expect(chips).toHaveLength(2);
		await expect(chips[0]).toHaveAttribute(
			"aria-label",
			`Main folder: ${site}`,
		);
		await expect(
			canvas.getByRole("combobox", { name: "Add folder" }),
		).toHaveFocus();
	},
};

const editedProject = {
	slug: "conduit",
	title: "Conduit",
	folders: [app, docs] as const,
};

export const SessionModeSet: Story = {
	args: {
		project: {
			...editedProject,
			title: "Isolated workspace",
			sessionMode: "worktree",
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await expect(
			canvas.getByRole("combobox", { name: "Default session mode" }),
		).toHaveValue("worktree");
		await expect(canvas.getByRole("button", { name: "Save" })).toBeDisabled();
	},
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
			canvas.getByText(
				"Pick one or more folders. The first is the project's main folder.",
			),
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
				.getAllByTestId("project-folder-chip")
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
