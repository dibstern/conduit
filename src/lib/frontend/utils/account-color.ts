const ACCOUNT_COLOR_CLASSES = [
	"bg-project-1",
	"bg-project-3",
	"bg-fill-green",
	"bg-fill-blue",
	"bg-fill-amber",
	"bg-project-4",
] as const;

// FNV-1a keeps a name's colour stable across sessions and browsers.
export function colorIndex(key: string, count: number): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < key.length; index++)
		hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
	return (hash >>> 0) % count;
}

export function accountColorClass(instanceId: string): string {
	return (
		ACCOUNT_COLOR_CLASSES[
			colorIndex(instanceId, ACCOUNT_COLOR_CLASSES.length)
		] ?? ACCOUNT_COLOR_CLASSES[0]
	);
}
