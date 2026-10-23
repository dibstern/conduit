import {
	getCachedInstanceById,
	getInstanceById,
} from "../stores/instance.svelte.js";

const ACCOUNT_COLOR_CLASSES = [
	"bg-project-5",
	"bg-fill-green",
	"bg-project-4",
	"bg-project-1",
	"bg-project-3",
	"bg-project-2",
] as const;

export function accountColorClass(instanceId: string): string {
	const colorSlot = (
		getInstanceById(instanceId) ?? getCachedInstanceById(instanceId)
	)?.colorSlot;
	// Historical readings can outlive their configured account. They use blue
	// until instance metadata is available, without deriving identity from order.
	return ACCOUNT_COLOR_CLASSES[colorSlot ?? 0] ?? ACCOUNT_COLOR_CLASSES[0];
}
