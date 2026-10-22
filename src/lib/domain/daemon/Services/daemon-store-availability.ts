import { Context } from "effect";

/** Shared import failures. Runtime registration adds failures before publication. */
export const DaemonStoreAvailability = Context.Reference<Map<string, string>>(
	"DaemonStoreAvailability",
	{
		defaultValue: (): Map<string, string> => new Map(),
	},
);
