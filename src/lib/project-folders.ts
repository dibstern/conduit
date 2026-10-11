/** Folder names, with the full root only when names collide. */
export const labelProjectFolders = (folders: readonly string[]) => {
	const roots = folders.map((root) => ({
		root,
		label: root.split(/[/\\]/).filter(Boolean).at(-1) ?? root,
	}));
	return roots.map(({ root, label }) => ({
		root,
		label:
			roots.filter((folder) => folder.label === label).length > 1
				? root
				: label,
	}));
};

export type FolderIssue =
	| { readonly kind: "empty" }
	| { readonly kind: "duplicate"; readonly path: string }
	| {
			readonly kind: "main-taken";
			readonly path: string;
			readonly slug: string;
	  }
	| { readonly kind: "nested"; readonly path: string; readonly parent: string }
	| { readonly kind: "unknown-project"; readonly slug: string }
	| { readonly kind: "missing"; readonly path: string }
	| { readonly kind: "permission-denied"; readonly path: string }
	| { readonly kind: "not-a-folder"; readonly path: string }
	| { readonly kind: "conduit-worktree"; readonly path: string }
	| { readonly kind: "create-exists"; readonly path: string }
	| {
			readonly kind: "mkdir-failed";
			readonly path: string;
			readonly message: string;
	  }
	| {
			readonly kind: "git-init-failed";
			readonly path: string;
			readonly message: string;
	  }
	| { readonly kind: "sessions-running"; readonly count: number };

export const isPermissionDenied = (cause: unknown): boolean =>
	typeof cause === "object" &&
	cause !== null &&
	"code" in cause &&
	(cause.code === "EACCES" || cause.code === "EPERM");

export const checkFolders = (
	folders: readonly string[],
	otherProjects: readonly { slug: string; folders: readonly string[] }[],
): { errors: readonly FolderIssue[]; warnings: readonly FolderIssue[] } => {
	const errors: FolderIssue[] = [];
	const warnings: FolderIssue[] = [];
	if (folders.length === 0) errors.push({ kind: "empty" });
	const seen = new Set<string>();
	for (const path of folders) {
		if (seen.has(path)) errors.push({ kind: "duplicate", path });
		seen.add(path);
	}
	for (const project of otherProjects) {
		if (folders[0] !== undefined && folders[0] === project.folders[0]) {
			errors.push({ kind: "main-taken", path: folders[0], slug: project.slug });
		}
	}
	const paths = [...seen].map((path) => ({
		path,
		segments: path.split(/[/\\]/).filter(Boolean),
	}));
	for (const child of paths) {
		for (const parent of paths) {
			if (
				parent.segments.length < child.segments.length &&
				parent.segments.every(
					(segment, index) => child.segments[index] === segment,
				)
			) {
				warnings.push({
					kind: "nested",
					path: child.path,
					parent: parent.path,
				});
			}
		}
	}
	return { errors, warnings };
};
