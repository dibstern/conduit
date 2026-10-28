import { labelProjectFolders } from "../../project-folders.js";
import { effectiveWorkingDirectory } from "../../session/session-workspace.js";
import type { WorktreeInfo } from "../../shared-types.js";
import { failureLine, toastFailure } from "../transport/rpc-errors.js";
import { rpc } from "../transport/ws-rpc-client.js";
import { getAvailableInstances } from "./discovery.svelte.js";
import { instanceState } from "./instance.svelte.js";
import { projectState } from "./project-state.svelte.js";
import { findSession, sessionState } from "./session.svelte.js";
import { composerAccountId } from "./usage.svelte.js";

export interface WorkspaceNotice {
	readonly kind: "mismatch" | "hint" | "moved-back" | "missing";
	readonly label: string;
	readonly actions: readonly {
		readonly kind: "move" | "recreate" | "continue" | "dismiss";
		readonly label: string;
		readonly run: () => void | Promise<void>;
	}[];
}

class WorkspaceCheckout {
	constructor(readonly sessionId: string | null) {}

	session = $derived.by(() => findSession(this.sessionId ?? ""));
	project = $derived(
		projectState.projects.find(
			(project) => project.slug === this.session?.projectSlug,
		),
	);
	directory = $derived(
		this.project
			? effectiveWorkingDirectory(
					this.project.folders[0],
					this.session?.workspace,
				)
			: undefined,
	);
	folderGit = $derived(
		this.session?.workspace
			? this.session.git
			: (this.session?.git ?? this.project?.git),
	);
	folders = $derived(this.folderGit?.folders ?? []);
	git = $derived(
		this.folderGit?.folders &&
			!this.folderGit.branch &&
			!this.folderGit.head &&
			this.folderGit.dirty === undefined
			? undefined
			: this.folderGit,
	);
	workspaceMissing = $derived(this.session?.workspaceMissing);
	workspaceMismatch = $derived(this.session?.workspaceMismatch);
	workspaceHint = $derived(this.session?.workspaceHint);
	private mismatchKey = $derived(
		this.workspaceMismatch
			? `${this.directory}\0${this.workspaceMismatch.actualPath}`
			: undefined,
	);
	// A local override lasts until new mismatch evidence invalidates this derived value.
	dismissedMismatch = $derived(this.mismatchKey === undefined);
	warningMismatch = $derived(
		this.dismissedMismatch ? undefined : this.workspaceMismatch,
	);
	warningPath = $derived(
		this.warningMismatch?.actualPath ?? this.workspaceHint,
	);
	warningDisplayPath = $derived.by(() => {
		const warningPath = this.warningPath;
		if (!warningPath) return "";
		const path = warningPath.replaceAll("\\", "/");
		if (!path.startsWith("/") && !/^[a-z]:\//i.test(path)) return warningPath;
		const base = (this.directory ?? "")
			.replaceAll("\\", "/")
			.split("/")
			.filter(Boolean);
		const target = path.split("/").filter(Boolean);
		if (target[0]?.includes(":") && target[0] !== base[0]) return warningPath;
		let common = 0;
		while (common < base.length && base[common] === target[common]) common++;
		return (
			[...base.slice(common).map(() => ".."), ...target.slice(common)].join(
				"/",
			) || "."
		);
	});
	hintLabel = $derived(
		`working in ${
			this.workspaceHint
				?.replace(/[\\/]+$/, "")
				.split(/[\\/]/)
				.pop() || this.workspaceHint
		}?`,
	);
	missingFolders = $derived(this.workspaceMissing?.folders ?? []);
	missingFolderLabels = $derived(
		labelProjectFolders(this.missingFolders.map(({ folder }) => folder)),
	);
	private instance = $derived(
		getAvailableInstances().find(
			(instance) => instance.id === composerAccountId(this.session),
		),
	);
	canListWorktrees = $derived(
		!!this.session &&
			(this.instance?.capabilities?.supportsWorktree ??
				instanceState.providerCapabilities[this.instance?.driver ?? ""]
					?.supportsWorktree) !== false,
	);
	canRenameBranch = $derived(this.session?.canRenameBranch === true);
	notices = $derived.by((): readonly WorkspaceNotice[] => {
		const notices: WorkspaceNotice[] = [];
		if (this.workspaceMismatch)
			notices.push({
				kind: "mismatch",
				label: `Workspace mismatch: Claude is working in ${this.workspaceMismatch.actualPath}`,
				actions: [
					{
						kind: "move",
						label: "Retry move",
						run: () => this.move(this.directory ?? ""),
					},
					{
						kind: "dismiss",
						label: "Dismiss",
						run: () =>
							this.dismiss(
								this.workspaceMismatch?.actualPath ?? "",
								"mismatch",
							),
					},
				],
			});
		if (this.workspaceHint)
			notices.push({
				kind: "hint",
				label: this.hintLabel,
				actions: [
					{
						kind: "move",
						label: "Move",
						run: () => this.move(this.workspaceHint ?? ""),
					},
					{
						kind: "dismiss",
						label: "Dismiss",
						run: () => this.dismiss(this.workspaceHint ?? ""),
					},
				],
			});
		if (this.session?.workspace?.cause === "missing")
			notices.push({
				kind: "moved-back",
				label: "moved back: worktree removed",
				actions: [],
			});
		if (this.workspaceMissing)
			notices.push({
				kind: "missing",
				label: this.missingFolders.length
					? `worktree missing: ${this.missingFolderLabels.map(({ label }) => label).join(", ")}`
					: "worktree missing",
				actions: [
					...(this.workspaceMissing.canRecreate
						? [
								{
									kind: "recreate" as const,
									label: "Recreate worktree",
									run: () => this.recover("recreate"),
								},
							]
						: []),
					{
						kind: "continue",
						label: "Continue in main folder",
						run: () => this.recover("continue"),
					},
				],
			});
		return notices;
	});
	rowNotices = $derived(
		this.notices.filter(
			(notice) => notice.kind !== "mismatch" || !this.dismissedMismatch,
		),
	);
	warningNotice = $derived(
		this.rowNotices.find(
			(notice) => notice.kind === "mismatch" || notice.kind === "hint",
		),
	);

	showWorktrees = $state(false);
	worktrees = $state<readonly WorktreeInfo[] | undefined>();
	currentDirectory = $state<string | undefined>();
	moving = $state(false);
	dismissing = $state(false);
	showBranchRename = $state(false);
	branchRenameOpener = $state<HTMLElement>();
	branchName = $state("");
	branchRenameError = $state<string | undefined>();
	renamingBranch = $state(false);
	private worktreeRequest = 0;

	openBranchRename(opener: HTMLElement | undefined) {
		this.branchName =
			this.git?.branch ??
			this.folders.find((folder) => !folder.shared && folder.branch)?.branch ??
			"";
		this.branchRenameError = undefined;
		this.branchRenameOpener = opener;
		this.showBranchRename = true;
	}

	async renameBranch() {
		if (
			!this.sessionId ||
			!this.canRenameBranch ||
			this.renamingBranch ||
			!this.branchName.trim()
		)
			return;
		this.renamingBranch = true;
		this.branchRenameError = undefined;
		try {
			await rpc("RenameSessionBranch", {
				sessionId: this.sessionId,
				branchName: this.branchName,
			});
			this.showBranchRename = false;
		} catch (error) {
			this.branchRenameError = failureLine(error, "Could not rename branch");
		} finally {
			this.renamingBranch = false;
		}
	}

	async openWorktrees() {
		if (!this.sessionId || !this.canListWorktrees) return;
		this.showWorktrees = true;
		this.worktrees = undefined;
		this.currentDirectory = undefined;
		const request = ++this.worktreeRequest;
		try {
			const result = await rpc("ListWorktrees", { sessionId: this.sessionId });
			if (request !== this.worktreeRequest) return;
			this.worktrees = result.worktrees;
			this.currentDirectory = result.directory;
		} catch (error) {
			if (request !== this.worktreeRequest) return;
			this.worktrees = [];
			toastFailure("Could not list worktrees")(error);
		}
	}

	async move(path: string) {
		if (!this.sessionId || this.moving || this.dismissing) return;
		this.moving = true;
		try {
			await rpc("MoveSessionWorkspace", { sessionId: this.sessionId, path });
		} catch (error) {
			toastFailure("Could not move session")(error);
		} finally {
			this.moving = false;
		}
	}

	async recover(action: "recreate" | "continue") {
		if (!this.sessionId || this.moving || this.dismissing) return;
		this.moving = true;
		try {
			if (action === "recreate")
				await rpc("RecreateSessionWorktree", { sessionId: this.sessionId });
			else
				await rpc("ContinueSessionInMainFolder", { sessionId: this.sessionId });
		} catch (error) {
			toastFailure(
				action === "recreate"
					? "Could not recreate worktree"
					: "Could not continue in main folder",
			)(error);
		} finally {
			this.moving = false;
		}
	}

	async dismiss(path: string, source: "hint" | "mismatch" = "hint") {
		if (source === "mismatch" && this.warningMismatch?.actualPath === path) {
			this.dismissedMismatch = true;
			return;
		}
		if (!this.sessionId || this.moving || this.dismissing) return;
		this.dismissing = true;
		try {
			await rpc("DismissWorkspaceHint", { sessionId: this.sessionId, path });
		} catch (error) {
			toastFailure("Could not dismiss workspace hint")(error);
		} finally {
			this.dismissing = false;
		}
	}
}

// Replacing the owner on navigation also isolates in-flight replies from the next session.
const currentCheckout = $derived(new WorkspaceCheckout(sessionState.currentId));

export function getWorkspaceCheckout() {
	return currentCheckout;
}
