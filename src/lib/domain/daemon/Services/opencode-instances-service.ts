import {
	Context,
	Data,
	type Effect,
	type Option,
	type Scope,
	type Stream,
} from "effect";
import type { OpenCodeConnectionStatus } from "../../../contracts/ws-rpc.js";
import { OpenCodeConnectionError } from "../../../errors.js";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import type { ConnectionHealth } from "../../../types.js";

export type OpenCodeInstanceEvent = {
	readonly instanceId: string;
	readonly health: ConnectionHealth;
} & (
	| {
			readonly _tag: "event";
			readonly payload: unknown;
			readonly directory?: string;
	  }
	| { readonly _tag: "heartbeat" }
	/** Successful transport connection, including reconnects with unchanged state. */
	| { readonly _tag: "connected" }
	/** Transport loss, including quiet managed instances with no lifecycle change. */
	| { readonly _tag: "disconnected" }
	| {
			/** Lifecycle transition; repeats are never emitted. */
			readonly _tag: "connection";
			readonly state: OpenCodeConnectionStatus;
			/** The managed process has stopped, rather than only its transport. */
			readonly managedStopped?: boolean;
	  }
);

/** Valid only inside the scope that acquired it. */
export type OpenCodeClient = OpenCodeAPI;

export class OpenCodeUnavailable extends Data.TaggedError(
	"OpenCodeUnavailable",
)<{
	readonly instanceId: string;
	readonly reason:
		| "not-configured"
		| "not-running"
		| "spawn-failed"
		| "unreachable";
	readonly message: string;
}> {}

/** The background SDK boundary wraps this expected rejection in a fiber failure. */
export const isOpenCodeNotRunningError = (error: unknown): boolean => {
	const cause = error instanceof OpenCodeConnectionError ? error.cause : error;
	const failure = cause;
	return (
		failure instanceof OpenCodeUnavailable && failure.reason === "not-running"
	);
};

export interface OpenCodeInstances {
	/**
	 * Passive, scoped subscription: no process, no connection. Receives events
	 * for `directories` from every instance stream that `use` has opened. It
	 * never keeps a stream open; the instance's demand does.
	 * A directory callback keeps that same subscription current as workspaces change.
	 * Acquiring the stream's pull registers the subscriber before returning.
	 */
	readonly events: (
		directories: readonly string[] | (() => readonly string[]),
		instanceId?: string,
	) => Stream.Stream<OpenCodeInstanceEvent>;
	/**
	 * Client for a reachable instance, starting it first when it is not
	 * running: managed instances spawn, external ones are health-checked.
	 * Concurrent callers share one start; a stop in progress finishes first.
	 * The open scope counts as demand, as do busy sessions and pending
	 * prompts OpenCode reports. Without demand the instance stops after an
	 * idle grace period (external ones only lose their stream).
	 */
	readonly use: (
		instanceId: string,
		directory?: string,
	) => Effect.Effect<OpenCodeClient, OpenCodeUnavailable, Scope.Scope>;
	/** Inventory hold. A server started only by borrowers gets a short idle grace. */
	readonly borrow: (
		instanceId: string,
		directory?: string,
	) => Effect.Effect<OpenCodeClient, OpenCodeUnavailable, Scope.Scope>;
	/**
	 * Client when the instance is running; None otherwise. Makes no request.
	 * A null directory uses the instance default, bypassing relay defaults.
	 */
	readonly ifRunning: (
		instanceId: string,
		directory?: string | null,
	) => Effect.Effect<Option.Option<OpenCodeClient>, never, Scope.Scope>;
	/** Hold a running instance and its stream for this scope; never start it. */
	readonly useIfRunning: (
		instanceId: string,
		directory?: string,
	) => Effect.Effect<Option.Option<OpenCodeClient>, never, Scope.Scope>;
	/** Admin stop, regardless of demand: stops the process and closes its stream. */
	readonly stop: (instanceId: string) => Effect.Effect<void>;
}

export class OpenCodeInstancesTag extends Context.Service<
	OpenCodeInstancesTag,
	OpenCodeInstances
>()("OpenCodeInstances") {}
