import { Context, type Effect, Layer, type Stream } from "effect";
import type { SessionGit as GitState } from "../../../shared-types.js";
import { makeSessionGit } from "../Layers/session-git-layer.js";

export interface SessionGitChange {
	readonly directory: string;
	readonly sessionIds: readonly string[];
	readonly version: number;
}

/** Published workspace git. Freshness, subprocesses and ownership stay private. */
export class SessionGit extends Context.Service<
	SessionGit,
	{
		readonly read: (sessionId: string) => Effect.Effect<GitState | undefined>;
		readonly changes: Stream.Stream<SessionGitChange>;
		readonly invalidate: (
			target: { readonly sessionId: string } | { readonly directory: string },
		) => Effect.Effect<void>;
	}
>()("SessionGit") {}

export const SessionGitLive = Layer.effect(SessionGit, makeSessionGit);
