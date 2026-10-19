/** Keep a send identifiable in native history even if its live echo is missed. */
const prefix = "msg_conduit_";

export const openCodeInputMessageId = (inputId: string): string =>
	`${prefix}${inputId}`;

export const inputIdFromOpenCodeMessageId = (
	messageId: string,
): string | undefined =>
	messageId.startsWith(prefix) ? messageId.slice(prefix.length) : undefined;
