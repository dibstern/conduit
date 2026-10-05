import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
	type FindFoldersResponse,
	ProjectSaveRejected,
} from "../../../contracts/ws-rpc.js";
import type { FindFoldersRpcInput } from "../../transport/ws-rpc-client.js";
import ProjectDialog from "./ProjectDialog.svelte";

const root = "/Users/dev/src";
const app = `${root}/conduit`;
const docs = `${root}/conduit-docs`;
const site = `${root}/conduit-site`;
const notes = `${root}/conduit-notes`;
const existing = [app, docs, site, `${app}/packages/sdk`];

async function findFolders({
	query,
}: FindFoldersRpcInput): Promise<FindFoldersResponse> {
	return {
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
		const options = canvas.getAllByRole("option");
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

export const Errors: Story = {
	args: {
		projects: [
			{ slug: "conduit", title: "Conduit", directory: app, folders: [app] },
		],
	},
	play: async ({ canvasElement }) => {
		const canvas = canvasFor(canvasElement);
		await addPath(canvasElement, app);
		await expect(canvas.getByRole("alert")).toHaveTextContent(
			"already the main folder",
		);
		await expect(canvas.getByRole("link", { name: "Conduit" })).toHaveAttribute(
			"href",
			"/?p=conduit",
		);
		await expect(
			canvas.getByRole("button", { name: "Add project" }),
		).toBeDisabled();
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
		});
	},
};
