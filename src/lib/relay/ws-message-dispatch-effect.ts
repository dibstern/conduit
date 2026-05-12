import { Cause, Effect } from "effect";
import { ClientMessageSerializationTag } from "../effect/client-message-serialization.js";
import { RateLimiterTag } from "../effect/rate-limiter-layer.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { dispatchMessageEffect } from "../handlers/index.js";
import type { Logger, LogLevel } from "../logger.js";
import { setLogLevel } from "../logger.js";
import type { RelayMessage } from "../types.js";

export type RelayWsDispatch<R> = (
	clientId: string,
	type: string,
	payload: unknown,
) => Effect.Effect<void, unknown, R>;

export interface RelayWsMessageDispatchOptions<R = never> {
	readonly clientId: string;
	readonly handler: string;
	readonly payload: unknown;
	readonly sendTo: (clientId: string, message: RelayMessage) => void;
	readonly log: Logger;
	readonly dispatch?: RelayWsDispatch<R>;
}

const validLogLevels = new Set<LogLevel>([
	"debug",
	"verbose",
	"info",
	"warn",
	"error",
]);

function getPayloadLevel(payload: unknown): unknown {
	if (typeof payload !== "object" || payload === null) return undefined;
	if (!("level" in payload)) return undefined;
	return Reflect.get(payload, "level");
}

function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && validLogLevels.has(value as LogLevel);
}

const renderDispatchError = (
	clientId: string,
	sendTo: (clientId: string, message: RelayMessage) => void,
	log: Logger,
) =>
	Effect.catchAllCause((cause) =>
		Cause.isInterruptedOnly(cause)
			? Effect.interrupt
			: Effect.sync(() => {
					const error = Cause.squash(cause);
					log.error(
						`Error handling message for ${clientId}:`,
						formatErrorDetail(error),
					);
					sendTo(
						clientId,
						RelayError.fromCaught(error, "HANDLER_ERROR").toSystemError(),
					);
				}),
	);

export const handleRelayWsMessage = <R = never>({
	clientId,
	handler,
	payload,
	sendTo,
	log,
	dispatch = dispatchMessageEffect,
}: RelayWsMessageDispatchOptions<R>): Effect.Effect<
	void,
	never,
	RateLimiterTag | ClientMessageSerializationTag | R
> =>
	Effect.gen(function* () {
		if (handler === "message") {
			const limiter = yield* RateLimiterTag;
			const result = yield* limiter.checkLimit(clientId);
			if (!result.allowed) {
				yield* Effect.sync(() =>
					sendTo(clientId, {
						type: "system_error",
						code: "RATE_LIMITED",
						message: `Rate limited. Try again in ${Math.ceil((result.retryAfterMs ?? 1000) / 1000)}s`,
					}),
				);
				return;
			}
		}

		if (handler === "set_log_level") {
			const level = getPayloadLevel(payload);
			if (isLogLevel(level)) {
				yield* Effect.sync(() => {
					setLogLevel(level);
					log.info(`Log level changed to ${level} by client ${clientId}`);
				});
			}
			return;
		}

		const serialization = yield* ClientMessageSerializationTag;
		yield* serialization
			.withClient(clientId, dispatch(clientId, handler, payload))
			.pipe(renderDispatchError(clientId, sendTo, log));
	});
