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
	readonly reason: "not-configured" | "unreachable";
	readonly message: string;
}> {}

export interface OpenCodeInstances {
	/**
	 * Passive, scoped subscription. This never starts an OpenCode process.
	 * Holds `instanceId`'s stream open (default instance when omitted) and
	 * receives events for `directories` from every open instance stream.
	 */
	readonly events: (
		directories: readonly string[],
		instanceId?: string,
	) => Stream.Stream<OpenCodeInstanceEvent>;
	/** Client for a reachable instance; never starts or stops a process. */
	readonly use: (
		instanceId: string,
		directory?: string,
	) => Effect.Effect<OpenCodeClient, OpenCodeUnavailable, Scope.Scope>;
	readonly ifRunning: (
		instanceId: string,
		directory?: string,
	) => Effect.Effect<Option.Option<OpenCodeClient>, never, Scope.Scope>;
}

export class OpenCodeInstancesTag extends Context.Tag("OpenCodeInstances")<
	OpenCodeInstancesTag,
	OpenCodeInstances
>() {}
