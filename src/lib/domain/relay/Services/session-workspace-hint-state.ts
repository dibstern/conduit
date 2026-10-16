import { Context, Layer } from "effect";

/** The dismissed hint generation for each session, borrowed from Session Activity. */
export class SessionWorkspaceHintStateTag extends Context.Tag(
	"SessionWorkspaceHintState",
)<SessionWorkspaceHintStateTag, Map<string, number>>() {}

export const SessionWorkspaceHintStateLive = Layer.sync(
	SessionWorkspaceHintStateTag,
	() => new Map<string, number>(),
);
