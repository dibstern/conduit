/** Keep a send identifiable in native history even if its live echo is missed. */
const prefix = "msg_conduit_";

export const openCodeInputMessageId = (inputId: string): string =>
	`${prefix}${inputId}`;

export const inputIdFromOpenCodeMessageId = (
	messageId: string,
): string | undefined =>
	messageId.startsWith(prefix) ? messageId.slice(prefix.length) : undefined;

/** A fork's seed: the source's transcript, sent without a reply. It is the
 *  model's context, not a message, so the stored transcript leaves it out.
 *  The prefix sorts before every send's id. */
const forkSeedPrefix = "msg_conduit-fork_";

export const openCodeForkSeedMessageId = (sessionId: string): string =>
	`${forkSeedPrefix}${sessionId}`;

export const isOpenCodeForkSeed = (messageId: unknown): boolean =>
	typeof messageId === "string" && messageId.startsWith(forkSeedPrefix);
