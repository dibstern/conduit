import { Context, Layer } from "effect";

/** The dismissed hint generation for each session, borrowed from Session Activity. */
export class SessionWorkspaceHintStateTag extends Context.Service<
	SessionWorkspaceHintStateTag,
	Map<string, number>
>()("SessionWorkspaceHintState") {}

export const SessionWorkspaceHintStateLive = Layer.sync(
	SessionWorkspaceHintStateTag,
	() => new Map<string, number>(),
);
