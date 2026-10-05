// Re-exports the handler functions.

export {
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "./model.js";
export {
	clearSessionInputDraft,
	getSessionInputDraft,
	handleMessage,
	rewindSessionToMessage,
	syncInputDraftForSession,
} from "./prompt.js";
export { reloadProviderSessionForClient } from "./reload.js";
export {
	loadMoreHistoryForSession,
	markSessionUnreadForClient,
	renameSessionForClient,
	setSessionAutoSettleForClient,
	setSessionPinnedForClient,
	setSessionSettledForClient,
} from "./session.js";
export { handleGetToolContent } from "./tool-content.js";
