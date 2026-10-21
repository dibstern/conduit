import { Context, type Ref } from "effect";

/** Daemon registration scope. Standalone stores roll up their whole family. */
export const SessionRollupProjects = Context.Reference<
	Ref.Ref<readonly string[]> | undefined
>("SessionRollupProjects", { defaultValue: () => undefined });
