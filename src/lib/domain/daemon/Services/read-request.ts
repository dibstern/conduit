import { Context, Effect } from "effect";
import type { RpcServer } from "effect/rpc";

// Effect 4 context references are inherited by request fibers and their children.
export const ReadRequest = Context.Reference<string | undefined>(
	"conduit/ReadRequest",
	{ defaultValue: () => undefined },
);

export const withReadRequest = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	method = "read",
): Effect.Effect<A, E, R> => Effect.provideService(effect, ReadRequest, method);

export const withReadRequestContext = (
	protocol: RpcServer.Protocol["Service"],
): RpcServer.Protocol["Service"] => ({
	...protocol,
	run: (handle) =>
		protocol.run((clientId, message) => {
			const handling = handle(clientId, message);
			if (message._tag !== "Request") return handling;
			const method = message.tag;
			return /^(Get|List|Subscribe|Search|Find)/.test(method) ||
				method === "ResolveSession" ||
				method === "ResolveSessionMode" ||
				method === "ResolveClaudeSettings" ||
				method === "InspectSessionWorktrees" ||
				method === "PreviewContinuation" ||
				method === "QuotaForAccounts" ||
				method === "LoadMoreHistory" ||
				method === "DetectProxy"
				? withReadRequest(handling, method)
				: handling;
		}),
});
