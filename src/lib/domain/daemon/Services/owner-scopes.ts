import { type Cause, Context, Data, type Effect, type Scope } from "effect";
import type { SessionDirectoryReadError } from "./session-directory.js";

export type OwnerCloseReason = "detach" | "remove";
export type OwnerTarget =
	| { readonly kind: "project"; readonly projectId: string }
	| { readonly kind: "session"; readonly sessionId: string };

export class OwnerScopeClosedError extends Data.TaggedError(
	"OwnerScopeClosedError",
)<{
	readonly target: OwnerTarget | { readonly kind: "daemon" };
	readonly reason: OwnerCloseReason;
}> {}

export class OwnerScopeProvenanceError extends Data.TaggedError(
	"OwnerScopeProvenanceError",
)<{
	readonly sessionId: string;
}> {}

export class OwnerScopeProjectNotRegisteredError extends Data.TaggedError(
	"OwnerScopeProjectNotRegisteredError",
)<{
	readonly projectId: string;
}> {}

export class OwnerScopeCloseError extends Data.TaggedError(
	"OwnerScopeCloseError",
)<{
	readonly target: OwnerTarget;
	readonly cause: Cause.Cause<never>;
}> {}

/** Checked access to a sequential Scope. Raw Scope.provide allows late acquisition. */
export interface OwnerScope {
	/** Acquire resources only; do not reenter acquire/close for the same owner. */
	readonly acquire: <A, E, R>(
		resource: Effect.Effect<A, E, R | Scope.Scope>,
	) => Effect.Effect<A, E | OwnerScopeClosedError, R>;
}

export class OwnerScopes extends Context.Service<
	OwnerScopes,
	{
		/** Check registration on every lookup; reopen only after the previous generation finishes closing. */
		readonly projectScope: (
			projectId: string,
		) => Effect.Effect<
			OwnerScope,
			OwnerScopeClosedError | OwnerScopeProjectNotRegisteredError
		>;
		/** Explicitly closed session ids stay fenced, including across project generations. */
		readonly sessionScope: (
			sessionId: string,
		) => Effect.Effect<
			OwnerScope,
			| OwnerScopeClosedError
			| OwnerScopeProjectNotRegisteredError
			| OwnerScopeProvenanceError
			| SessionDirectoryReadError
		>;
		/** First close wins. Releases receive Exit.succeed(reason); never close from that owner's release. */
		readonly close: (
			target: OwnerTarget,
			reason: OwnerCloseReason,
		) => Effect.Effect<void, OwnerScopeCloseError>;
	}
>()("OwnerScopes") {}
