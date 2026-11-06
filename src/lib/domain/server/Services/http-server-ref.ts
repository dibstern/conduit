import type * as http from "node:http";
import { Context, Layer, Ref } from "effect";

/**
 * The daemon's listening HTTP server, null until `HttpServerLive` listens and
 * after it closes. WS routing reads it to attach upgrades, as t3code's readers
 * yield the server its HTTP layer owns (apps/server/src/server.ts:305-320).
 */
export class HttpServerRefTag extends Context.Service<
	HttpServerRefTag,
	Ref.Ref<http.Server | null>
>()("HttpServerRef") {}

export const HttpServerRefLive: Layer.Layer<HttpServerRefTag> = Layer.effect(
	HttpServerRefTag,
	Ref.make<http.Server | null>(null),
);
