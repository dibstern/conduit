import { Context } from "effect";

/** Fixed at startup. Standalone and per-file consumers have no import blocks. */
export class DaemonStoreAvailability extends Context.Reference<DaemonStoreAvailability>()(
	"DaemonStoreAvailability",
	{ defaultValue: (): ReadonlyMap<string, string> => new Map() },
) {}
