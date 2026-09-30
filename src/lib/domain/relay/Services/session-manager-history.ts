import { Effect, HashMap, Ref } from "effect";
import { OpenCodeApiError } from "../../../errors.js";
import type { HistoryMessage } from "../../../shared-types.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { LoggerTag } from "./services.js";
import { SessionManagerError } from "./session-manager-error.js";
import {
	type HistoryPage,
	type LoadHistoryOptions,
} from "./session-manager-service.js";
import { SessionManagerStateTag } from "./session-manager-state.js";

const DEFAULT_HISTORY_PAGE_SIZE = 50;
export const CURSOR_SCAN_LIMIT = 10_000;

/**
 * Clear the stored pagination cursor for a session.
 */
export const clearPaginationCursor = (sessionId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		yield* Ref.update(stateRef, (s) => ({
			...s,
			paginationCursors: HashMap.remove(s.paginationCursors, sessionId),
		}));
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.clearPaginationCursor", {
			attributes: { sessionId },
		}),
	);

/**
 * Seed a pagination cursor without overwriting a cursor already advanced by load-more.
 */
export const seedPaginationCursor = (sessionId: string, messageId: string) =>
	Effect.gen(function* () {
		const stateRef = yield* SessionManagerStateTag;
		yield* Ref.update(stateRef, (s) => {
			if (HashMap.has(s.paginationCursors, sessionId)) {
				return s;
			}
			return {
				...s,
				paginationCursors: HashMap.set(
					s.paginationCursors,
					sessionId,
					messageId,
				),
			};
		});
	}).pipe(
		Effect.annotateLogs("sessionId", sessionId),
		Effect.withSpan("session.seedPaginationCursor", {
			attributes: { sessionId },
		}),
	);

const loadHistoryByCursorScan = (sessionId: string, cursorId: string) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const all = yield* Effect.tryPromise({
			try: () =>
				api.session.messagesPage(sessionId, { limit: CURSOR_SCAN_LIMIT }),
			catch: (cause) => cause,
		}).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "loadHistoryByCursorScan",
						cause,
					}),
			),
		);

		const cursorIdx = all.findIndex((message) => message.id === cursorId);
		if (cursorIdx <= 0) {
			return { messages: [], hasMore: false } satisfies HistoryPage;
		}

		return {
			messages: all.slice(0, cursorIdx) as unknown as HistoryMessage[],
			hasMore: false,
		} satisfies HistoryPage;
	});

/**
 * Load one page of session history and maintain the service-owned pagination cursor.
 */
export const loadHistory = (
	sessionId: string,
	offset = 0,
	options?: LoadHistoryOptions,
) =>
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const stateRef = yield* SessionManagerStateTag;
		const log = yield* LoggerTag;
		const historyPageSize =
			options?.historyPageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
		const state = yield* Ref.get(stateRef);
		const cursorOption =
			offset > 0 ? HashMap.get(state.paginationCursors, sessionId) : undefined;
		const before =
			cursorOption?._tag === "Some" ? cursorOption.value : undefined;

		if (offset > 0 && !before) {
			return { messages: [], hasMore: false } satisfies HistoryPage;
		}

		const fetchPage = (requestOptions: { limit: number; before?: string }) =>
			Effect.tryPromise({
				try: () => api.session.messagesPage(sessionId, requestOptions),
				catch: (cause) => cause,
			});

		const page = yield* fetchPage({
			limit: historyPageSize,
			...(before ? { before } : {}),
		}).pipe(
			Effect.catchAll((cause) => {
				if (
					before &&
					cause instanceof OpenCodeApiError &&
					cause.responseStatus === 400
				) {
					return Effect.gen(function* () {
						log.warn(
							`Pagination cursor failed for ${sessionId.slice(0, 12)} — falling back to full fetch`,
						);
						yield* clearPaginationCursor(sessionId);

						if (offset > 0) {
							return yield* loadHistoryByCursorScan(sessionId, before);
						}

						const retryPage = yield* fetchPage({ limit: historyPageSize }).pipe(
							Effect.mapError(
								(retryCause) =>
									new SessionManagerError({
										operation: "loadHistory",
										cause: retryCause,
									}),
							),
						);
						return {
							messages: retryPage as unknown as HistoryMessage[],
							hasMore: retryPage.length >= historyPageSize,
						} satisfies HistoryPage;
					});
				}

				return Effect.fail(
					new SessionManagerError({ operation: "loadHistory", cause }),
				);
			}),
		);

		if ("messages" in page) {
			return page;
		}

		const oldest = page[0];
		if (oldest) {
			yield* Ref.update(stateRef, (s) => ({
				...s,
				paginationCursors: HashMap.set(
					s.paginationCursors,
					sessionId,
					oldest.id,
				),
			}));
		}

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
	offset?: number,
	options?: LoadHistoryOptions,
) =>
	Effect.gen(function* () {
		const page = yield* loadHistory(sessionId, offset, options);
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
