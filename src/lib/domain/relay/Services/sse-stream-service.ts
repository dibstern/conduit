import { Context, Effect, Layer } from "effect";
import { SSEStream, type SSEStreamPort } from "../../../relay/sse-stream.js";
import { OpenCodeAPITag } from "../../provider/Services/opencode-api-service.js";
import { LoggerTag } from "./services.js";

export class SSEStreamTag extends Context.Tag("SSEStream")<
	SSEStreamTag,
	SSEStreamPort
>() {}

export const SSEStreamLive: Layer.Layer<
	SSEStreamTag,
	never,
	OpenCodeAPITag | LoggerTag
> = Layer.scoped(
	SSEStreamTag,
	Effect.gen(function* () {
		const api = yield* OpenCodeAPITag;
		const log = yield* LoggerTag;
		const stream = new SSEStream({
			api,
			log: log.child("sse"),
		});
		yield* Effect.addFinalizer(() => stream.drainEffect());
		return stream;
	}),
);
