import { Context } from "effect";

/** Fixed at startup. Standalone and per-file consumers have no import blocks. */
export const DaemonStoreAvailability = Context.Reference<
	ReadonlyMap<string, string>
>("DaemonStoreAvailability", {
	defaultValue: (): ReadonlyMap<string, string> => new Map(),
});
