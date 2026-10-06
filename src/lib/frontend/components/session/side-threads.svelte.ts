import { goalDetails } from "../../stores/goal.svelte.js";
import { tasksPanel } from "./background-tasks.svelte.js";

/** Whether the header's Side Threads list is open. One per page, like tasksPanel. */
export const sideThreadsPanel = $state({ open: false });

/** Opens the list, closing the header's other pull-downs: one at a time. */
export function openSideThreads(open = true): void {
	goalDetails.open = false;
	tasksPanel.open = false;
	sideThreadsPanel.open = open;
}
