import { Context, type Stream } from "effect";
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

export interface OpenCodeInstances {
	/** Passive, scoped subscription. This never starts an OpenCode process. */
	readonly events: (
		directories: readonly string[],
	) => Stream.Stream<OpenCodeInstanceEvent>;
}

export class OpenCodeInstancesTag extends Context.Tag("OpenCodeInstances")<
	OpenCodeInstancesTag,
	OpenCodeInstances
>() {}
