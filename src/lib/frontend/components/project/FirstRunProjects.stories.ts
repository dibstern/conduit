import type { Meta, StoryObj } from "@storybook/svelte-vite";
import type { Rpc } from "effect/rpc";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
	type FindFolders,
	type FindFoldersResponse,
	ProjectSaveRejected,
	type SaveProject,
	type SaveProjectResponse,
} from "../../../contracts/ws-rpc.js";
import { projectState } from "../../stores/project.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import type { ProjectInfo } from "../../types.js";
import FirstRunProjects from "./FirstRunProjects.svelte";

const home = "/Users/dev";
const conduit = `${home}/src/personal/conduit`;
const api = `${home}/src/work/api`;
const dotfiles = `${home}/src/personal/dotfiles`;
const bb = `${home}/src/personal/conduit-competitors/bb`;
const picked = `${home}/side-project`;
const recent = [
	[conduit, 2],
	[api, 24],
	[dotfiles, 72],
	[bb, 120],
] as const;
const paths = recent.map(([path]) => path);

function recentEntries(): FindFoldersResponse["entries"] {
	const now = Date.now();
	return recent.map(([path, hoursAgo]) => ({
		path,
		isGitRepo: true,
		reason: "recent",
		exists: true,
		lastUsed: now - hoursAgo * 3_600_000,
	}));
}

async function findFolders({
	query,
}: Rpc.PayloadConstructor<typeof FindFolders>): Promise<FindFoldersResponse> {
	return {
		home,
		entries:
			query === ""
				? recentEntries()
				: [{ path: picked, isGitRepo: true, reason: "match", exists: true }],
	};
}

async function saveProject(
	input: Rpc.PayloadConstructor<typeof SaveProject>,
): Promise<SaveProjectResponse> {
	const path = input.folders[0];
	if (typeof path !== "string") throw new Error("Expected an existing folder");
	const project: ProjectInfo = {
		slug: path.split("/").at(-1) ?? "project",
		title: input.title ?? "Project",
		folders: [path],
	};
	projectState.projects = [...projectState.projects, project];
	return {
		savedSlug: project.slug,
		projects: projectState.projects,
		warnings: [],
	};
}

const meta = {
	title: "Project/FirstRunProjects",
	component: FirstRunProjects,
	tags: ["autodocs", "viewport-capture"],
	beforeEach: () => {
		const projects = projectState.projects;
		const compact = sessionViewState.compact;
		projectState.projects = [];
		sessionViewState.compact = window.innerWidth < 768;
		return () => {
			projectState.projects = projects;
			sessionViewState.compact = compact;
		};
	},
	parameters: {
		layout: "fullscreen",
		docs: { story: { inline: false } },
		a11y: { test: "error" },
	},
	args: {
		findFolders: fn(findFolders),
		saveProject: fn(saveProject),
		oncomplete: fn(),
	},
} satisfies Meta<typeof FirstRunProjects>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecentRepositories: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("button", { name: "Add 3 projects" });
		const rows = canvas.getAllByTestId("first-run-repo");
		await expect(rows.map((row) => row.getAttribute("data-path"))).toEqual(
			paths,
		);
		for (const name of ["conduit", "api", "dotfiles"]) {
			await expect(canvas.getByRole("checkbox", { name })).toBeChecked();
		}
		await expect(
			canvas.getByRole("checkbox", { name: "bb" }),
		).not.toBeChecked();
		await expect(rows[0]).toHaveTextContent("~/src/personal/conduit");
		await expect(rows[0]).toHaveTextContent(
			sessionViewState.compact ? "2h" : "2h ago",
		);
		await expect(rows[1]).toHaveTextContent(
			sessionViewState.compact ? "1d" : "yesterday",
		);
		await expect(rows[2]).toHaveTextContent(
			sessionViewState.compact ? "3d" : "3d ago",
		);
	},
};

export const NothingSelected: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("button", { name: "Add 3 projects" });
		await userEvent.click(canvas.getByRole("checkbox", { name: "conduit" }));
		await expect(
			canvas.getByRole("button", { name: "Add 2 projects" }),
		).toBeEnabled();
		await userEvent.click(canvas.getByRole("checkbox", { name: "api" }));
		await expect(
			canvas.getByRole("button", { name: "Add 1 project" }),
		).toBeEnabled();
		await userEvent.click(canvas.getByRole("checkbox", { name: "dotfiles" }));
		await expect(
			canvas.getByRole("button", { name: "Add 0 projects" }),
		).toBeDisabled();
		for (const checkbox of canvas.getAllByRole("checkbox")) {
			await expect(checkbox).not.toBeChecked();
		}
		await expect(args["saveProject"]).not.toHaveBeenCalled();
	},
};

export const BrowseAndPick: Story = {
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await canvas.findByRole("button", { name: "Add 3 projects" });
		await userEvent.click(
			canvas.getByText(/^Find (?:or browse for )?another folder…$/),
		);
		const input = canvas.getByRole("combobox", { name: "Add folder" });
		await expect(input).toHaveValue("~/");
		await userEvent.click(await canvas.findByRole("option", { name: picked }));
		await expect(
			canvas.getByRole("checkbox", { name: "side-project" }),
		).toBeChecked();
		await expect(
			canvas.getByRole("button", { name: "Add 4 projects" }),
		).toBeEnabled();
		await expect(
			canvas
				.getAllByTestId("first-run-repo")
				.map((row) => row.getAttribute("data-path")),
		).toEqual([...paths, picked]);
		await expect(canvas.getByRole("option", { name: picked })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(canvas.queryByTestId("folder-picker-new")).toBeNull();
		await expect(
			canvas.queryByRole("option", { name: /New folder/ }),
		).toBeNull();
		await expect(args["saveProject"]).not.toHaveBeenCalled();
	},
};

export const PartialFailure: Story = {
	args: {
		findFolders: fn(async () => ({
			home,
			entries: recentEntries().slice(0, 3),
		})),
		saveProject: fn(
			async (input: Rpc.PayloadConstructor<typeof SaveProject>) => {
				if (input.folders[0] === api) {
					throw new ProjectSaveRejected({
						issues: [{ kind: "permission-denied", path: api }],
					});
				}
				return saveProject(input);
			},
		),
	},
	play: async ({ canvasElement, args }) => {
		const canvas = within(canvasElement);
		await userEvent.click(
			await canvas.findByRole("button", { name: "Add 3 projects" }),
		);
		await waitFor(async () => {
			await expect(args["saveProject"]).toHaveBeenCalledTimes(3);
			await expect(canvas.getAllByTestId("first-run-repo")).toHaveLength(1);
		});
		for (const [index, path] of paths.slice(0, 3).entries()) {
			await expect(args["saveProject"]).toHaveBeenNthCalledWith(index + 1, {
				title: path.split("/").at(-1),
				folders: [path],
			});
		}
		const row = canvas.getByTestId("first-run-repo");
		await expect(row).toHaveAttribute("data-path", api);
		await expect(
			within(row).getByRole("checkbox", { name: "api" }),
		).toBeChecked();
		await expect(row).toHaveTextContent(
			`Permission denied: ${api}. Check the folder permissions and try again.`,
		);
		await expect(
			canvas.getByRole("button", { name: "Add 1 project" }),
		).toBeEnabled();
		await expect(args["oncomplete"]).not.toHaveBeenCalled();
		await expect(
			projectState.projects.map((project) => project.folders[0]),
		).toEqual([conduit, dotfiles]);
	},
};
