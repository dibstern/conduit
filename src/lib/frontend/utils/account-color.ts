const ACCOUNT_COLOR_CLASSES = [
	"bg-project-1",
	"bg-project-3",
	"bg-fill-green",
	"bg-fill-blue",
	"bg-fill-indigo",
	"bg-project-4",
] as const;

// FNV-1a keeps the account's identity colour stable across sessions and browsers.
export function accountColorClass(instanceId: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < instanceId.length; index++)
		hash = Math.imul(hash ^ instanceId.charCodeAt(index), 0x01000193);
	return (
		ACCOUNT_COLOR_CLASSES[(hash >>> 0) % ACCOUNT_COLOR_CLASSES.length] ??
		ACCOUNT_COLOR_CLASSES[0]
	);
}
