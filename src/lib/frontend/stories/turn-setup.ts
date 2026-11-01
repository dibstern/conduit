import type { CategorySet } from "../../contracts/category-set.js";
import type { MessageSurfacingStatus } from "../../contracts/message-surfacing.js";
import {
	getOrCreateSessionActivity,
	SessionMessages,
	sessionActivity,
	sessionMessages,
} from "../stores/chat.svelte.js";
import {
	messageSurfacing,
	sessionSurfaceLevel,
	setSessionSurfaceLevel,
} from "../stores/message-surfacing.svelte.js";
import { replaceRoute, routerState } from "../stores/router.svelte.js";
import {
	setTurnMinimised,
	turnMinimised,
} from "../stores/turn-minimisation.svelte.js";
import type { ChatMessage } from "../types.js";
import type { Turn } from "../utils/turns.js";
import { openSessionForSetup } from "./session-setup.js";

/** Standalone panels still resolve pin, step and citation anchors from a transcript. */
export function setupTurnStory({
	turn,
	sessionId,
	surfacing,
}: {
	turn: Turn;
	sessionId: string | undefined;
	surfacing?:
		| { status: MessageSurfacingStatus; categorySet: CategorySet }
		| undefined;
}): () => void {
	if (!sessionId) return () => {};
	const previousRoute = routerState.path + routerState.search;
	const previousMessages = sessionMessages.get(sessionId);
	const previousActivity = sessionActivity.get(sessionId);
	const previousStatus = messageSurfacing.status;
	const previousCategorySet = messageSurfacing.categorySet;
	const previousLevel = sessionSurfaceLevel(sessionId);
	const previousMinimised = turnMinimised(sessionId, turn.id);
	const messages: ChatMessage[] = [
		{ ...turn.user, type: "user", uuid: turn.id, text: turn.user?.text ?? "" },
		...turn.segments.flatMap((segment, index) => [
			...segment.activity,
			// A supplied activity message needs subsequent activity to stay out of reply.
			...(segment.activity.at(-1)?.type === "assistant"
				? [
						{
							type: "thinking" as const,
							uuid: `${turn.id}-story-boundary-${index}`,
							text: "",
							done: true,
						},
					]
				: []),
			...segment.reply,
			...(segment.end ? [segment.end] : []),
		]),
	];
	const chat = new SessionMessages();
	chat.messages = messages;
	sessionMessages.set(sessionId, chat);
	sessionActivity.delete(sessionId);
	getOrCreateSessionActivity(sessionId).phase = turn.live
		? "processing"
		: "idle";
	setSessionSurfaceLevel(sessionId, null);
	setTurnMinimised(sessionId, turn.id, null);
	if (surfacing) {
		messageSurfacing.status = surfacing.status;
		messageSurfacing.categorySet = surfacing.categorySet;
	}
	openSessionForSetup(sessionId);
	return () => {
		replaceRoute(previousRoute);
		if (previousMessages) sessionMessages.set(sessionId, previousMessages);
		else sessionMessages.delete(sessionId);
		if (previousActivity) sessionActivity.set(sessionId, previousActivity);
		else sessionActivity.delete(sessionId);
		messageSurfacing.status = previousStatus;
		messageSurfacing.categorySet = previousCategorySet;
		setSessionSurfaceLevel(sessionId, previousLevel ?? null);
		setTurnMinimised(sessionId, turn.id, previousMinimised ?? null);
	};
}
