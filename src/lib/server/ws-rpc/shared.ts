import { Effect } from "effect";
import { WsRpcError, type WsRpcGroup } from "../../contracts/ws-rpc.js";
import { resolveSessionRequestFolders } from "../../domain/relay/Services/provider-turn-dispatch.js";

export type WsRpcHandlerMap = Parameters<typeof WsRpcGroup.of>[0];

export const resolveSessionRequestDirectory = (
	request: {
		readonly sessionId?: string | undefined;
		readonly root?: string | undefined;
	},
	kind: "file" | "terminal",
) =>
	Effect.gen(function* () {
		const { workspaceRoot, effectiveFolders } =
			yield* resolveSessionRequestFolders(request.sessionId);
		const directory =
			request.root === undefined
				? workspaceRoot
				: effectiveFolders.find(({ root }) => root === request.root)?.directory;
		if (directory === undefined) {
			return yield* Effect.fail(
				new WsRpcError({ message: `Unknown ${kind} root: ${request.root}` }),
			);
		}
		return directory;
	});

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
