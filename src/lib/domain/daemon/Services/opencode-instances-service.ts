import {
	Context,
	Data,
	type Effect,
	type Option,
	type Scope,
	type Stream,
} from "effect";
import type { OpenCodeAPI } from "../../../instance/opencode-api.js";
import type { ConnectionHealth } from "../../../types.js";

export type OpenCodeInstanceEvent = {
	readonly instanceId: string;
	readonly health: ConnectionHealth;
} & (
	| { readonly _tag: "event"; readonly payload: unknown }
	| { readonly _tag: "heartbeat" }
	| {
			readonly _tag: "connection";
			readonly state: "connected" | "disconnected" | "reconnecting";
			readonly error?: Error;
			readonly attempt?: number;
			readonly delay?: number;
	  }
);

/** Valid only inside the scope that acquired it. */
export type OpenCodeClient = OpenCodeAPI;

export class OpenCodeUnavailable extends Data.TaggedError(
	"OpenCodeUnavailable",
)<{
	readonly instanceId: string;
	readonly reason: "not-configured" | "spawn-failed" | "unreachable";
	readonly message: string;
}> {}

export interface OpenCodeInstances {
	/**
	 * Passive, scoped subscription: no process, no connection. Receives events
	 * for `directories` from every instance stream that `use` has opened. It
	 * never keeps a stream open; the instance's demand does.
	 */
	readonly events: (
		directories: readonly string[],
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
	/** Client when the instance is running; None otherwise. Makes no request. */
	readonly ifRunning: (
		instanceId: string,
		directory?: string,
	) => Effect.Effect<Option.Option<OpenCodeClient>, never, Scope.Scope>;
	/** Admin stop, regardless of demand: stops the process and closes its stream. */
	readonly stop: (instanceId: string) => Effect.Effect<void>;
}

export class OpenCodeInstancesTag extends Context.Tag("OpenCodeInstances")<
	OpenCodeInstancesTag,
	OpenCodeInstances
>() {}
