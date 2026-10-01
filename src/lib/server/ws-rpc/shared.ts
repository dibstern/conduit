import { Effect } from "effect";
import { WsRpcError, type WsRpcGroup } from "../../contracts/ws-rpc.js";

export type WsRpcHandlerMap = Parameters<typeof WsRpcGroup.of>[0];

export const mapRpcFailure =
	(operation: string) =>
	(error: unknown): Effect.Effect<never, WsRpcError> =>
		error instanceof WsRpcError
			? Effect.fail(error)
			: Effect.fail(
					new WsRpcError({
						message: `${operation} failed: ${String(error)}`,
					}),
				);
