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
	 * for `directories` from every instance stream that `use` has opened, and
	 * keeps those streams open while subscribed.
	 */
	readonly events: (
		directories: readonly string[],
		instanceId?: string,
	) => Stream.Stream<OpenCodeInstanceEvent>;
	/**
	 * Client for a reachable instance, starting it first when it is not
	 * running: managed instances spawn, external ones are health-checked.
	 * Concurrent callers share one start.
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
	/** Stops the instance's process and closes its event stream. */
	readonly stop: (instanceId: string) => Effect.Effect<void>;
}

export class OpenCodeInstancesTag extends Context.Tag("OpenCodeInstances")<
	OpenCodeInstancesTag,
	OpenCodeInstances
>() {}
