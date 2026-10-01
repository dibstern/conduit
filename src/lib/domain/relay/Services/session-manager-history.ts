import { Effect } from "effect";
import type { HistoryMessage } from "../../../shared-types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { SessionManagerError } from "./session-manager-error.js";
import type {
	HistoryPage,
	LoadHistoryOptions,
} from "./session-manager-service.js";

const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const CURSOR_SCAN_LIMIT = 10_000;

/** Load the newest REST page for initial OpenCode history while backfill runs. */
export const loadHistory = (sessionId: string, options?: LoadHistoryOptions) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const historyPageSize =
			options?.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
		const page = yield* Effect.tryPromise({
			try: () =>
				api.session.messagesPage(sessionId, { limit: historyPageSize }),
			catch: (cause) => cause,
		}).pipe(
			Effect.mapError(
				(cause) => new SessionManagerError({ operation: "loadHistory", cause }),
			),
		);
		return {
			messages: page as unknown as HistoryMessage[],
			hasMore: page.length >= historyPageSize,
		} satisfies HistoryPage;
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.loadHistory", { attributes: { sessionId } }),
	);

/**
 * Load history and pre-render assistant markdown in one service boundary.
 */
export const loadPreRenderedHistory = (
	sessionId: string,
	options?: LoadHistoryOptions,
) =>
	Effect.gen(function* () {
		const page = yield* loadHistory(sessionId, options);
		const renderer = yield* Effect.tryPromise(
			() => import("../../../relay/markdown-renderer.js"),
		).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "loadPreRenderedHistory",
						cause,
					}),
			),
		);
		yield* Effect.sync(() => renderer.preRenderHistoryMessages(page.messages));
		return page;
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.loadPreRenderedHistory", {
			attributes: { sessionId },
		}),
	);
