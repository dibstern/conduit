import { Cause, Effect } from "effect";
import { ClientMessageSerializationTag } from "../domain/relay/Services/client-message-serialization.js";
import { RelayCommandGateTag } from "../domain/relay/Services/relay-command-gate.js";
import { formatErrorDetail, RelayError } from "../errors.js";
import { dispatchMessageEffect } from "../handlers/index.js";
import type { Logger } from "../logger.js";
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

export interface RelayWsMessageGateOptions<R = never>
	extends RelayWsMessageDispatchOptions<R> {
	readonly commandId: string;
	readonly receivedAt?: number;
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
	ClientMessageSerializationTag | R
> =>
	Effect.gen(function* () {
		const serialization = yield* ClientMessageSerializationTag;
		yield* serialization
			.withClient(clientId, dispatch(clientId, handler, payload))
			.pipe(renderDispatchError(clientId, sendTo, log));
	});

export const handleRelayWsMessageThroughGate = <R = never>({
	commandId,
	receivedAt = Date.now(),
	...options
}: RelayWsMessageGateOptions<R>): Effect.Effect<
	void,
	never,
	RelayCommandGateTag | ClientMessageSerializationTag | R
> =>
	Effect.gen(function* () {
		const gate = yield* RelayCommandGateTag;
		yield* gate
			.submit(
				{
					commandId,
					clientId: options.clientId,
					messageType: options.handler,
					receivedAt,
				},
				handleRelayWsMessage(options),
			)
			.pipe(
				Effect.catchTag("RelayCommandRejected", (error) =>
					Effect.sync(() => {
						options.log.warn(error.message);
						options.sendTo(
							options.clientId,
							RelayError.fromCaught(error, "INTERNAL_ERROR").toSystemError(),
						);
					}),
				),
			);
	});
