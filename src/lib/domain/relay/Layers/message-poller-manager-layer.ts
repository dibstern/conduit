import { Cause, Effect, Layer } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { MessagePollerManager } from "../../../relay/message-poller-impl.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import {
	PendingSendOwnershipLive,
	PendingSendOwnershipTag,
} from "../Services/pending-send-ownership.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
} from "../Services/services.js";

export interface MessagePollerManagerLiveOptions {
	readonly hasViewers?: (sessionId: string) => boolean;
}

export const makeMessagePollerManagerLive = (
	options: MessagePollerManagerLiveOptions = {},
): Layer.Layer<
	PollerManagerTag,
	never,
	OpenCodeAPITag | ConfigTag | LoggerTag
> =>
	Layer.scoped(
		PollerManagerTag,
		Effect.gen(function* () {
			const client = yield* OpenCodeAPITag;
			const ownership = yield* PendingSendOwnershipTag;
			const config = yield* ConfigTag;
			const log = yield* LoggerTag;
			const pollerLog = log.child("poller-mgr");
			const manager = new MessagePollerManager({
				client,
				resolveOrigin: ownership.resolve,
				log: pollerLog,
				...(options.hasViewers != null && { hasViewers: options.hasViewers }),
				...(config.messagePollerInterval != null && {
					interval: config.messagePollerInterval,
				}),
			});

			yield* Effect.addFinalizer(() =>
				Effect.tryPromise({
					try: () => manager.drain(),
					catch: (cause) => cause,
				}).pipe(
					Effect.catchAll((cause) =>
						Effect.sync(() =>
							pollerLog.warn(
								`Failed to drain message pollers during shutdown: ${formatErrorDetail(cause)}`,
							),
						),
					),
					Effect.catchAllCause((cause) =>
						Effect.sync(() =>
							pollerLog.warn(
								`Defect while draining message pollers during shutdown: ${Cause.pretty(cause)}`,
							),
						),
					),
				),
			);

			return manager;
		}),
	).pipe(Layer.provide(PendingSendOwnershipLive));
