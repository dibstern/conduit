import { resolve } from "node:path";

// This is the single owner of where project history lives.
export const projectEventsDbPath = (project: {
	readonly directory: string;
}): string => resolve(project.directory, ".conduit", "events.db");
