function normalize(path: string): string {
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (part === "..") parts.pop();
		else if (part && part !== ".") parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export function parseFolderQuery(
	query: string,
	home: string,
): {
	isPath: boolean;
	folder: string | undefined;
	crumbs: { label: string; query: string }[];
	upQuery: string | undefined;
} {
	const text = query.trim();
	const isPath = /^[/~]/.test(text);
	if (
		!isPath ||
		(text.startsWith("~") &&
			(!home || (text !== "~" && !text.startsWith("~/"))))
	) {
		return { isPath, folder: undefined, crumbs: [], upQuery: undefined };
	}
	const path = normalize(text.startsWith("~") ? home + text.slice(1) : text);
	const folder =
		text.endsWith("/") || text === "~"
			? path
			: path.slice(0, path.lastIndexOf("/")) || "/";
	const homePath = home ? normalize(home) : "";
	const underHome =
		homePath && (folder === homePath || folder.startsWith(`${homePath}/`));
	const crumbs = [
		{ label: underHome ? "~" : "/", query: underHome ? "~/" : "/" },
	];
	const parts = (underHome ? folder.slice(homePath.length) : folder)
		.split("/")
		.filter(Boolean);
	for (const label of parts) {
		crumbs.push({
			label,
			query: `${crumbs[crumbs.length - 1]?.query}${label}/`,
		});
	}
	return { isPath, folder, crumbs, upQuery: crumbs.at(-2)?.query };
}

export function ghost(
	query: string,
	entries: readonly { path: string }[],
	home: string,
): string {
	const text = query.trim();
	const { folder } = parseFolderQuery(text, home);
	if (!folder || text === "~" || text.endsWith("/")) return "";
	const prefix = text.slice(text.lastIndexOf("/") + 1);
	const parent = folder === "/" ? "/" : `${folder}/`;
	const matches = entries
		.map(({ path }) => normalize(path))
		.filter((path) => {
			if (!path.startsWith(parent)) return false;
			const name = path.slice(parent.length);
			return (
				!name.includes("/") &&
				name.toLowerCase().startsWith(prefix.toLowerCase())
			);
		});
	return matches.length === 1
		? `${matches[0]?.slice(parent.length + prefix.length)}/`
		: "";
}
