import { Context, type Effect } from "effect";

/** Refresh workspace git and publish it through the existing session feeds. */
export class SessionGitServiceTag extends Context.Service<
	SessionGitServiceTag,
	{
		readonly refresh: (options?: {
			readonly sessionId?: string;
			readonly staleOnly?: boolean;
		}) => Effect.Effect<void, unknown>;
	}
>()("SessionGitService") {}
