import type { Meta, StoryObj } from "@storybook/svelte-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { WorktreeBranchRenameError } from "../../../contracts/worktree.js";
import type { SessionGit } from "../../../shared-types.js";
import { instanceState } from "../../stores/instance.svelte.js";
import { projectState } from "../../stores/project.svelte.js";
import { routerState } from "../../stores/router.svelte.js";
import { sessionState } from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { mockClaudeAccount } from "../../stories/mocks.js";
import { openSessionForSetup } from "../../stories/session-setup.js";
import { connectedSocket, replyRpc } from "../../stories/sockets.js";
import { applySessionChange } from "../../transport/session-subscription.svelte.js";
import type { rpc } from "../../transport/ws-rpc-client.js";
import type { SessionInfo } from "../../types.js";
import AgentWorktreeLifecycle from "./__fixtures__/AgentWorktreeLifecycle.svelte";
import GitIdentity from "./GitIdentity.svelte";

type CheckoutSeed = Pick<
	SessionInfo,
	| "git"
	| "workspace"
	| "workspaceMissing"
	| "workspaceMismatch"
	| "workspaceHint"
	| "canRenameBranch"
> & {
	worktrees?: Awaited<ReturnType<typeof rpc<"ListWorktrees">>>;
	renameError?: WorktreeBranchRenameError;
};

const moveWorkspace = fn((_payload: unknown) => ({
	directory: "/src/conduit",
}));
const dismissWorkspaceHint = fn((_payload: unknown) => ({ ok: true }));
const renameSessionBranch = fn((_payload: unknown) => ({ ok: true }));

// The visual harness pins Date.now, and the store drops a change whose sequence
// does not advance, so count up instead of reading the clock.
let lastSequence = Date.now();

const agentWorktreeGit: SessionGit = {
	branch: "worktree-header-agent",
	worktree: "header-agent",
	dirty: true,
	ahead: 1,
	behind: 0,
};

const meta = {
	title: "Session/GitIdentity",
	component: GitIdentity,
	tags: ["autodocs"],
	args: { directory: "/src/conduit", presentation: "control" },
	beforeEach: ({ canvasElement, args, parameters, id }) => {
		const previous = {
			sessions: [...sessionState.liveSessions.values()],
			projects: projectState.projects,
			instances: instanceState.instances,
			path: routerState.path,
			search: routerState.search,
			compact: sessionViewState.compact,
			composerWidth: sessionViewState.composerWidth,
		};
		const checkout = parameters["checkout"] as CheckoutSeed | undefined;
		const directory = args["directory"] ?? "/src/conduit";
		const restoreSocket = connectedSocket();
		moveWorkspace.mockClear();
		dismissWorkspaceHint.mockClear();
		renameSessionBranch.mockClear();
		const restoreReplies = [
			replyRpc(
				"ListWorktrees",
				() => checkout?.worktrees ?? { directory, worktrees: [] },
			),
			replyRpc("MoveSessionWorkspace", moveWorkspace),
			replyRpc("DismissWorkspaceHint", dismissWorkspaceHint),
			replyRpc("RecreateSessionWorktree", () => ({ directory })),
			replyRpc("ContinueSessionInMainFolder", () => ({ directory })),
			replyRpc("RenameSessionBranch", (payload) => {
				renameSessionBranch(payload);
				if (checkout?.renameError) throw checkout.renameError;
				return { ok: true };
			}),
		];
		instanceState.instances = [
			{
				...mockClaudeAccount,
				capabilities: {
					supportsMultiFolder: true,
					supportsWorktree: checkout?.worktrees !== undefined,
				},
			},
		];
		projectState.projects = [
			{ slug: "conduit", title: "conduit", folders: [directory] },
		];
		applySessionChange({
			_tag: "snapshot",
			sequence: ++lastSequence,
			rows: [
				{
					id,
					accountId: mockClaudeAccount.id,
					projectSlug: "conduit",
					title: "Checkout",
					status: "idle",
					git: checkout?.git,
					workspace: checkout?.workspace,
					workspaceMissing: checkout?.workspaceMissing,
					workspaceMismatch: checkout?.workspaceMismatch,
					workspaceHint: checkout?.workspaceHint,
					canRenameBranch: checkout?.canRenameBranch,
				},
			],
		});
		openSessionForSetup(id, "conduit");
		sessionViewState.compact = false;
		sessionViewState.composerWidth = 760;
		// The root outlives the story; take back layout changes from fit checks.
		const style = canvasElement.getAttribute("style");
		return () => {
			for (const restoreReply of restoreReplies) restoreReply();
			restoreSocket();
			applySessionChange({
				_tag: "snapshot",
				rows: previous.sessions,
				sequence: ++lastSequence,
			});
			projectState.projects = previous.projects;
			instanceState.instances = previous.instances;
			routerState.path = previous.path;
			routerState.search = previous.search;
			sessionViewState.compact = previous.compact;
			sessionViewState.composerWidth = previous.composerWidth;
			if (style === null) canvasElement.removeAttribute("style");
			else canvasElement.setAttribute("style", style);
		};
	},
} satisfies Meta<typeof GitIdentity>;

export default meta;
type Story = StoryObj<typeof meta> & {
	parameters?: { checkout?: CheckoutSeed };
};

export const NoGit: Story = {};

export const BranchOnly: Story = {
	parameters: {
		checkout: {
			git: { branch: "main" },
		},
	},
};

export const ControlBlockResize: Story = {
	...BranchOnly,
	play: async ({ canvasElement }) => {
		const identity = within(canvasElement).getByTestId("composer-checkout");
		const slot = identity.parentElement;
		if (!slot) throw new Error("Missing checkout slot");
		canvasElement.style.width = "320px";
		await waitFor(() => {
			expect(slot.getBoundingClientRect().width).toBe(220);
			expect(identity.querySelector('[data-part="branch"]')).toHaveTextContent(
				"main",
			);
		});
		canvasElement.style.width = "180px";
		await waitFor(() => {
			expect(identity.querySelector('[data-part="branch"]')).toBeNull();
			expect(slot.getBoundingClientRect().right).toBeLessThanOrEqual(
				canvasElement.getBoundingClientRect().right,
			);
		});
		canvasElement.style.width = "360px";
		await waitFor(() => {
			expect(slot.getBoundingClientRect().width).toBe(220);
			expect(identity.querySelector('[data-part="branch"]')).toHaveTextContent(
				"main",
			);
		});
	},
};

export const ControlGridResize: Story = {
	...ControlBlockResize,
	beforeEach: ({ canvasElement }) => {
		canvasElement.style.display = "grid";
	},
};

export const BranchAndWorktree: Story = {
	parameters: {
		checkout: {
			git: { branch: "feature/session-bar", worktree: "17xt" },
		},
	},
};

export const Dirty: Story = {
	parameters: {
		checkout: {
			git: { branch: "feature/session-bar", worktree: "17xt", dirty: true },
		},
	},
};

export const Narrow: Story = {
	args: {
		directory: "/src/conduit-project-with-a-very-long-name",
	},
	parameters: {
		checkout: {
			git: {
				branch: "feature/git-ui",
				worktree: "linked-worktree-with-a-long-name",
				dirty: true,
			},
		},
	},
	play: async ({ canvasElement }) => {
		const identity = within(canvasElement).getByTestId("composer-checkout");
		// The pill's own 220px cap is the narrowest that keeps its labels;
		// LongNames covers the collapse below it.
		const container = identity.parentElement;
		expect(container).not.toBeNull();
		if (!container) return;
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
	parameters: {
		checkout: {
			git: { branch: "main", ahead: 3, behind: 1 },
		},
	},
};

export const Detached: Story = {
	parameters: {
		checkout: {
			git: { head: "a1b2c3d" },
		},
	},
};

export const Rebasing: Story = {
	parameters: {
		checkout: {
			git: { branch: "feat/x", operation: "rebase", dirty: true },
		},
	},
};

export const Merged: Story = {
	parameters: {
		checkout: {
			git: { branch: "feat/x", merged: true },
		},
	},
};

export const DetailsOpen: Story = {
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
			canRenameBranch: true,
			worktrees: {
				directory: "/src/conduit",
				worktrees: [
					{ path: "/src/conduit", branch: "fix/draft-menus", main: false },
					{ path: "/src/conduit-main", branch: "main", main: true },
				],
			},
			git: {
				branch: "fix/draft-menus",
				worktree: "conduit-wt-draft",
				upstream: "origin/fix/draft-menus",
				head: "6b11104",
				oid: "6b11104a9c2e88d27395d13c706d876fbab99aa1",
				changes: { files: 9, insertions: 412, deletions: 38 },
				ahead: 3,
				behind: 1,
				dirty: true,
			},
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		await expect(
			within(document.body).getByRole("menu", { name: "Checkout" }),
		).toHaveTextContent("/src/conduit");
	},
};

export const NoUpstream: Story = {
	...DetailsOpen,
	// Storybook indexes tags statically, so a spread one is not seen.
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
			...DetailsOpen.parameters?.checkout,
			git: {
				branch: "local/topic",
				head: "6b11104",
				oid: "6b11104a9c2e88d27395d13c706d876fbab99aa1",
				dirty: true,
				changes: { files: 1, insertions: 2, deletions: 0 },
			},
		},
	},
};

export const Clean: Story = {
	...DetailsOpen,
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
			...DetailsOpen.parameters?.checkout,
			git: {
				branch: "main",
				head: "6b11104",
				oid: "6b11104a9c2e88d27395d13c706d876fbab99aa1",
				upstream: "origin/main",
				ahead: 0,
				behind: 0,
				dirty: false,
			},
		},
	},
};

export const FolderDetailsOpen: Story = {
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
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
						upstream: "origin/feature/api",
						head: "6b11104",
						oid: "6b11104a9c2e88d27395d13c706d876fbab99aa1",
						changes: { files: 3, insertions: 12, deletions: 4 },
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
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		const rows = within(canvasElement.ownerDocument.body).getAllByTestId(
			"session-folder-git",
		);
		await expect(rows).toHaveLength(3);
		await expect(rows[0]).toHaveTextContent("feature/web");
		await expect(rows[0]).toHaveTextContent("clean");
		await expect(rows[1]).toHaveTextContent("feature/api");
		await expect(rows[1]).toHaveTextContent("3 files changed +12 -4");
		await expect(rows[1]).toHaveTextContent("↑2 ↓1");
		await expect(rows[2]).toHaveTextContent("Detached at a1b2c3d");
	},
};

export const NonGitPrimary: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/notes",
	},
	parameters: {
		checkout: {
			git: {
				folders: [
					{
						root: "/src/api",
						label: "api",
						branch: "feature/api",
						dirty: true,
						changes: { files: 3, insertions: 12, deletions: 4 },
						ahead: 2,
						behind: 1,
					},
				],
			},
		},
	},
	play: async ({ canvasElement }) => {
		const identity = within(canvasElement).getByTestId("composer-checkout");
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
		await expect(rows[0]).toHaveTextContent("3 files changed +12 -4");
		await expect(rows[0]).toHaveTextContent("↑2 ↓1");
	},
};

export const SharedFolderDetailsOpen: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/conduit/worktrees/workspace/session/app",
	},
	parameters: {
		checkout: {
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
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
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
	},
	parameters: {
		checkout: {
			git: { branch: "feature/one", worktree: "conduit-one", dirty: true },
			worktrees: {
				directory: "/src/conduit-one",
				worktrees: [
					{ path: "/src/conduit", branch: "main", main: true },
					{ path: "/src/conduit-one", branch: "feature/one", main: false },
					{ path: "/src/conduit-two", branch: "feature/two", main: false },
				],
			},
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		await userEvent.click(
			within(document.body).getByRole("menuitem", {
				name: "Move to another worktree…",
			}),
		);
		await expect(
			await within(document.body).findByTestId("current-worktree"),
		).toBeVisible();
		await expect(
			await within(document.body).findByRole("menuitem", {
				name: /feature\/two/,
			}),
		).toBeVisible();
	},
};

export const RenameBranch: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/conduit/worktrees/workspace/rename-session/app",
	},
	parameters: {
		checkout: {
			git: { branch: "conduit/session-rename", worktree: "app", dirty: false },
			canRenameBranch: true,
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		await expect(
			within(canvasElement.ownerDocument.body).getByRole("menuitem", {
				name: /^Rename branch$/,
			}),
		).toBeVisible();
	},
};

export const RenameBranchError: Story = {
	...RenameBranch,
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
			...RenameBranch.parameters?.checkout,
			canRenameBranch: true,
			renameError: new WorktreeBranchRenameError({
				folder: "/src/api",
				reason: "already-exists",
				message: "Branch feature/taken already exists",
			}),
		},
	},
	play: async ({ canvasElement }) => {
		const body = within(canvasElement.ownerDocument.body);
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		await userEvent.click(
			body.getByRole("menuitem", { name: "Rename branch" }),
		);
		const dialog = body.getByRole("dialog", { name: "Rename branch" });
		const input = within(dialog).getByRole("textbox", { name: "Branch name" });
		await expect(input).toHaveValue("conduit/session-rename");
		await userEvent.clear(input);
		await userEvent.type(input, "feature/taken");
		await userEvent.click(
			within(dialog).getByRole("button", { name: /^Rename$/ }),
		);
		await waitFor(() =>
			expect(renameSessionBranch).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: sessionState.currentId,
					branchName: "feature/taken",
				}),
			),
		);
		await expect(within(dialog).getByRole("alert")).toHaveTextContent(
			"/src/api: Branch feature/taken already exists",
		);
		await expect(input).toHaveValue("feature/taken");
	},
};

export const RenameBranchErrorPhone: Story = {
	...RenameBranchError,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
};

export const WorkspaceMismatch: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit-two",
	},
	parameters: {
		checkout: {
			git: { branch: "feature/two", worktree: "conduit-two" },
			workspaceMismatch: {
				actualPath: "/src/conduit/.claude/worktrees/contract",
			},
		},
	},
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		const body = within(canvasElement.ownerDocument.body);
		await expect(body.getByTestId("workspace-mismatch")).toHaveTextContent(
			"/src/conduit/.claude/worktrees/contract",
		);
		await userEvent.click(body.getByRole("menuitem", { name: "Retry move" }));
		await waitFor(() =>
			expect(moveWorkspace).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: sessionState.currentId,
					path: "/src/conduit-two",
				}),
			),
		);
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		await expect(body.getByTestId("workspace-mismatch")).toBeVisible();
	},
};

export const MovedBack: Story = {
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
			git: { branch: "main" },
			workspace: { cause: "missing", origin: "existing", worktrees: {} },
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("workspace-notice-indicator"),
		).toHaveAttribute("aria-label", "moved back: worktree removed");
		await expect(canvas.getByTestId("composer-checkout")).toHaveAccessibleName(
			/moved back: worktree removed/,
		);
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
		const notice = canvas.getByTestId("workspace-notice-indicator");
		await expect(notice).toHaveAttribute("role", "img");
		await expect(notice).toHaveAttribute(
			"aria-label",
			"moved back: worktree removed",
		);
		await expect(notice).toHaveTextContent(/^$/);
		await expect(canvas.getByTestId("composer-checkout")).toHaveAccessibleName(
			/moved back: worktree removed/,
		);
	},
};

export const WorktreeMissing: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit-worktree",
	},
	parameters: {
		checkout: {
			workspace: { cause: "launch", origin: "existing", worktrees: {} },
			workspaceMissing: {
				path: "/src/conduit-worktree",
				branch: "conduit/missing-session",
				canRecreate: true,
			},
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("workspace-notice-indicator"),
		).toHaveAttribute("aria-label", "worktree missing");
		await expect(canvas.getByTestId("composer-checkout")).toHaveAccessibleName(
			/worktree missing/,
		);
	},
};

export const WorktreeMissingOpen: Story = {
	...WorktreeMissing,
	tags: ["viewport-capture"],
	play: async ({ canvasElement }) => {
		await userEvent.click(
			within(canvasElement).getByTestId("composer-checkout"),
		);
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			body.getByText(
				"This worktree is missing. It will be recreated from its branch on your next message.",
			),
		).toBeVisible();
		await expect(
			body.getByRole("menuitem", { name: "Recreate worktree" }),
		).toBeVisible();
		await expect(
			body.getByRole("menuitem", { name: "Continue in main folder" }),
		).toBeVisible();
	},
};

export const WorktreeMissingPhone: Story = {
	...WorktreeMissing,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("workspace-notice-indicator"),
		).toHaveAttribute("aria-label", "worktree missing");
		await expect(canvas.getByTestId("composer-checkout")).toHaveAccessibleName(
			/worktree missing/,
		);
	},
};

export const WorktreeMissingExtraFolder: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit-worktree",
	},
	parameters: {
		checkout: {
			workspace: { cause: "launch", origin: "existing", worktrees: {} },
			git: {
				branch: "conduit/multi-folder-session",
				worktree: "conduit-worktree",
				dirty: true,
				folders: [
					{
						root: "/src/conduit",
						label: "conduit",
						branch: "conduit/multi-folder-session",
						worktree: "conduit-worktree",
						dirty: true,
					},
					{ root: "/src/library", label: "library", missing: true },
				],
			},
			workspaceMissing: {
				path: "/src/library-worktree",
				branch: "conduit/multi-folder-session",
				canRecreate: true,
				folders: [
					{
						folder: "/src/library",
						path: "/src/library-worktree",
						branch: "conduit/multi-folder-session",
						canRecreate: true,
					},
				],
			},
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(
			canvas.getByTestId("workspace-notice-indicator"),
		).toHaveAttribute("aria-label", "worktree missing: library");
		await userEvent.click(canvas.getByTestId("composer-checkout"));
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			body.getByText(/^These worktrees are missing\./),
		).toBeVisible();
		await expect(
			body.getByTestId("workspace-missing-folder"),
		).toHaveTextContent("library");
		await expect(
			body.getByTestId("workspace-missing-folder"),
		).toHaveTextContent("/src/library-worktree");
		await expect(
			body.getByRole("menuitem", { name: "Recreate worktree" }),
		).toBeVisible();
		await expect(
			body.getByRole("region", { name: "library" }),
		).toHaveTextContent("Worktree missing");
		await expect(
			body.getByRole("region", { name: "library" }),
		).not.toHaveTextContent("clean");
	},
};

export const WorkspaceHint: Story = {
	tags: ["viewport-capture"],
	args: {
		directory: "/src/conduit",
	},
	parameters: {
		checkout: {
			git: { branch: "main" },
			workspaceHint: "/src/conduit-hint",
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		const hint = canvas.getByTestId("workspace-notice-indicator");
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
		const identity = canvas.getByTestId("composer-checkout");
		await userEvent.click(identity);
		await expect(body.getByTestId("workspace-hint-dismiss")).toBeVisible();
		await userEvent.click(body.getByTestId("workspace-hint-move"));
		await waitFor(() =>
			expect(moveWorkspace).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: sessionState.currentId,
					path: "/src/conduit-hint",
				}),
			),
		);
		await userEvent.click(identity);
		await userEvent.click(body.getByTestId("workspace-hint-dismiss"));
		await waitFor(() =>
			expect(dismissWorkspaceHint).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: sessionState.currentId,
					path: "/src/conduit-hint",
				}),
			),
		);
	},
};

export const WorkspaceHintPhone: Story = {
	...WorkspaceHint,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
};

export const Word: Story = {
	tags: ["viewport-capture"],
	args: {
		presentation: "word",
	},
	parameters: {
		checkout: {
			git: { branch: "account-chip", worktree: "account-chip" },
		},
	},
	play: async ({ canvasElement, args }) => {
		const checkout = within(canvasElement).getByTestId("composer-checkout");
		await expect(checkout).toHaveAttribute(
			"title",
			`${args["directory"]?.split("/").pop()} / account-chip`,
		);
		await userEvent.click(checkout);
		await expect(
			within(document.body).getByTestId("composer-checkout-menu"),
		).toHaveTextContent(args["directory"] ?? "");
	},
};

export const WordNarrow: Story = {
	...Word,
	tags: ["viewport-capture"],
	args: {
		presentation: "word",
		directory: "/src/conduit-worktrees",
	},
	parameters: {
		checkout: {
			git: {
				branch: "feature/session-account-chip-redesign",
				worktree: "account-chip",
			},
		},
	},
	beforeEach: () => {
		sessionViewState.composerWidth = 480;
	},
	play: async ({ canvasElement }) => {
		const checkout = within(canvasElement).getByTestId("composer-checkout");
		const container = checkout.parentElement;
		if (!container) throw new Error("Missing checkout wrapper");
		container.style.width = "160px";
		// The words line names the branch alone; the menu keeps the project.
		expect(checkout.querySelector('[data-part="project"]')).toBeNull();
		const branch = checkout.querySelector('[data-part="branch"]');
		if (!branch) throw new Error("Missing checkout branch");
		expect(branch.scrollWidth).toBeGreaterThan(branch.clientWidth);
		await userEvent.click(checkout);
		await expect(
			within(document.body).getByTestId("composer-checkout-menu"),
		).toHaveTextContent("feature/session-account-chip-redesign");
	},
};

export const WordPhone: Story = {
	...Word,
	tags: ["viewport-capture"],
	beforeEach: () => {
		sessionViewState.compact = true;
	},
};

export const WordAttention: Story = {
	args: {
		presentation: "word",
	},
	parameters: {
		checkout: {
			git: {
				branch: "account-chip",
				worktree: "account-chip",
				dirty: true,
				ahead: 2,
				behind: 1,
				operation: "rebase",
			},
		},
	},
};

export const WordWorkspaceHint: Story = {
	...WorkspaceHint,
	tags: ["viewport-capture"],
	args: {
		...WorkspaceHint.args,
		presentation: "word",
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const body = within(canvasElement.ownerDocument.body);
		await expect(
			canvas.getByTestId("workspace-notice-indicator"),
		).toHaveAttribute("aria-label", "working in conduit-hint?");
		await expect(
			canvas.queryByTestId("workspace-hint-move"),
		).not.toBeInTheDocument();
		await userEvent.click(canvas.getByTestId("composer-checkout"));
		await userEvent.click(body.getByTestId("workspace-hint-move"));
		await waitFor(() =>
			expect(moveWorkspace).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: sessionState.currentId,
					path: "/src/conduit-hint",
				}),
			),
		);
	},
};

async function playAgentMove(canvasElement: HTMLElement, exit: boolean) {
	const canvas = within(canvasElement);
	const body = within(canvasElement.ownerDocument.body);
	const identity = canvas.getByTestId("composer-checkout");
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
		"Composer checkout · Running turn",
	);
	await userEvent.click(identity);
	let menu = await body.findByRole("menu", { name: "Checkout" });
	await expect(
		within(menu).getByText("/src/conduit/.claude/worktrees/header-agent", {
			exact: true,
		}),
	).toBeVisible();
	await expect(within(menu).getByText(/· worktree/)).toBeVisible();
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
		"Composer checkout · Running turn",
	);
	await userEvent.click(identity);
	menu = await body.findByRole("menu", { name: "Checkout" });
	await expect(
		within(menu).getByText("/src/conduit", { exact: true }),
	).toBeVisible();
	await expect(within(menu).queryByText(/· worktree/)).not.toBeInTheDocument();
}

export const AgentEntersWorktree: Story = {
	tags: ["viewport-capture"],
	parameters: {
		checkout: {
			git: { branch: "main", dirty: false, ahead: 0, behind: 0 },
		},
	},
	render: (args) => {
		const directory = args["directory"];
		let originalGit: SessionGit | undefined;
		const setWorktree = (entered: boolean) => {
			const session = sessionState.sessions.get(sessionState.currentId ?? "");
			if (!session) throw new Error("Missing lifecycle session");
			if (entered) originalGit = session.git;
			applySessionChange({
				_tag: "upsert",
				sequence: ++lastSequence,
				item: {
					...session,
					git: entered ? agentWorktreeGit : originalGit,
					workspace: {
						cause: "agent",
						origin: "existing",
						worktrees: entered
							? { [directory]: `${directory}/.claude/worktrees/header-agent` }
							: {},
					},
				},
			});
		};
		return {
			Component: AgentWorktreeLifecycle,
			props: { ...args, setWorktree },
		};
	},
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
	parameters: {
		checkout: {
			git: {
				branch: "fix/draft-menus",
				worktree: "conduit-wt-draft",
				dirty: true,
			},
		},
	},
};

export const LongNames: Story = {
	args: {
		directory: "/src/spm-architecture-deepening",
	},
	parameters: {
		checkout: {
			git: { branch: "docs/architecture-deepening-design", dirty: true },
		},
	},
	play: async ({ canvasElement }) => {
		const identity = within(canvasElement).getByTestId("composer-checkout");
		const project = identity.querySelector('[data-part="project"]');
		const branch = identity.querySelector('[data-part="branch"]');
		expect(project).not.toBeNull();
		expect(branch).not.toBeNull();
		if (!project || !branch) return;
		// The control caps at the spec's pill width. The project gives up all of
		// its slack before the branch loses a character.
		expect(branch.scrollWidth).toBeGreaterThan(branch.clientWidth);
		expect(project.getBoundingClientRect().width).toBeCloseTo(
			Number.parseFloat(getComputedStyle(project).minWidth),
			0,
		);
		// Any narrower and the checkout collapses to its icon before the model
		// label has to truncate. Size the row: the pill rewrites its own style.
		canvasElement.style.width = "200px";
		await waitFor(() =>
			expect(identity.querySelector('[data-part="branch"]')).toBeNull(),
		);
		expect(identity.querySelector('[data-part="project"]')).toBeNull();
	},
};
