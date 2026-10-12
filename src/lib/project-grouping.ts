import type {
	GroupingMode,
	ProjectGroup,
	RepositoryIdentity,
} from "./shared-types.js";

/** Groups depend only on the primary folder and the effective mode. */
export function computeProjectGroups(
	projects: readonly {
		slug: string;
		title: string;
		folders: readonly [string, ...string[]];
		repositoryIdentities?: Readonly<Record<string, RepositoryIdentity>>;
		groupingMode: GroupingMode;
	}[],
): Readonly<Record<string, ProjectGroup>> {
	const groups = new Map<
		string,
		{ members: string[]; label: string; labelOwner: string }
	>();
	for (const project of projects) {
		const folder = project.folders[0];
		const identity = project.repositoryIdentities?.[folder];
		const grouped = project.groupingMode !== "off" && identity !== undefined;
		const key = JSON.stringify(
			grouped
				? project.groupingMode === "repository+subfolder"
					? [
							"repository+subfolder",
							identity.key,
							folder
								.slice(identity.root.replace(/\/+$/, "").length)
								.replace(/^\/+|\/+$/g, ""),
						]
					: ["repository", identity.key]
				: ["project", project.slug],
		);
		const label = grouped ? identity.name : project.title;
		const group = groups.get(key);
		if (!group) {
			groups.set(key, {
				members: [project.slug],
				label,
				labelOwner: project.slug,
			});
		} else {
			group.members.push(project.slug);
			// Remote spelling can preserve different casing. Pick the same label
			// even when last-use ordering changes or the input is reversed.
			if (project.slug < group.labelOwner) {
				group.label = label;
				group.labelOwner = project.slug;
			}
		}
	}
	return Object.fromEntries(
		[...groups].flatMap(([key, { members, label }]) =>
			members.map((slug) => [
				slug,
				{ key, label, needsProjectQualifier: members.length > 1 },
			]),
		),
	);
}
