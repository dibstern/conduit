import { Context, type Effect } from "effect";

/** Refresh workspace git and publish it through the existing session feeds. */
export class SessionGitServiceTag extends Context.Tag("SessionGitService")<
	SessionGitServiceTag,
	{ readonly refresh: () => Effect.Effect<void, unknown> }
>() {}
