import type { FolderIssue } from "../../../project-folders.js";

/** "main-taken" ends at "of": callers append the owning project. */
export function issueText(issue: FolderIssue): string {
	switch (issue.kind) {
		case "empty":
			return "Add at least one folder.";
		case "duplicate":
			return `${issue.path} is already added.`;
		case "main-taken":
			return `${issue.path} is already the main folder of`;
		case "nested":
			return `${issue.path} is inside ${issue.parent}. Sessions can already edit it.`;
		case "missing":
			return `${issue.path} no longer exists.`;
		case "permission-denied":
			return `Permission denied: ${issue.path}. Check the folder permissions and try again.`;
		case "not-a-folder":
			return `${issue.path} isn't a folder.`;
		case "conduit-worktree":
			return `${issue.path} belongs to a session worktree and cannot be added to a project.`;
		case "create-exists":
			return `${issue.path} already exists. Add it as an existing folder.`;
		case "mkdir-failed":
			return `Couldn't create ${issue.path}: ${issue.message}`;
		case "git-init-failed":
			return `Couldn't initialise git in ${issue.path}: ${issue.message}`;
		case "unknown-project":
			return `Project ${issue.slug} no longer exists.`;
		case "sessions-running":
			return `${issue.count} sessions are running. Save when they finish.`;
	}
}
