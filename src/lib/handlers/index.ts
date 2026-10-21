// Re-exports the handler functions.

export {
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "./model.js";
export {
	handleMessage,
	rewindSessionToMessage,
	syncInputDraft,
} from "./prompt.js";
export { reloadProviderSessionForClient } from "./reload.js";
export {
	loadMoreHistoryForSession,
	markSessionUnreadForClient,
	renameSessionForClient,
	setSessionArchivedForClient,
	setSessionAutoSettleForClient,
	setSessionPinnedForClient,
	setSessionSettledForClient,
} from "./session.js";
