import { Context, Data, type Effect } from "effect";
import type { ProjectNotFound } from "./project-registry-service.js";
import type { SessionDirectoryReadError } from "./session-directory.js";

export interface ResolvedProjectContext {
	readonly projectId: string;
	readonly mainFolder: string;
	readonly extraFolders: readonly string[];
	readonly shellEnv: Readonly<Record<string, string | undefined>>;
}

export interface ProjectContextOptions {
	/** Session workspaces can resolve their environment outside the main folder. */
	readonly directory?: string;
	readonly prepareShellEnv?: boolean;
}

export class SessionProjectNotFound extends Data.TaggedError(
	"SessionProjectNotFound",
)<{ readonly sessionId: string }> {
	get message(): string {
		return `No registered project owns session "${this.sessionId}"`;
	}
}

export class ProjectContext extends Context.Service<
	ProjectContext,
	{
		readonly forProject: (
			slug: string,
			options?: ProjectContextOptions,
		) => Effect.Effect<ResolvedProjectContext, ProjectNotFound>;
		readonly forSession: (
			id: string,
			options?: ProjectContextOptions,
		) => Effect.Effect<
			ResolvedProjectContext,
			ProjectNotFound | SessionProjectNotFound | SessionDirectoryReadError
		>;
	}
>()("ProjectContext") {}
