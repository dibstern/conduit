import { Context, Effect, Layer, PubSub } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import {
	type AccountResourceScopeOwner,
	AccountResourceScopesTag,
} from "../../domain/daemon/Services/account-resource-scopes.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../../domain/daemon/Services/daemon-pubsub.js";
import type { UsageReader } from "../usage-reader.js";
import { makeCodexAuth } from "./codex-auth.js";
import { makeCodexUsageReader } from "./codex-usage.js";

export class CodexAccountResources extends Context.Service<
	CodexAccountResources,
	AccountResourceScopeOwner<
		{
			readonly auth: Effect.Success<ReturnType<typeof makeCodexAuth>>;
			readonly usage: UsageReader;
		},
		WsRpcError
	>
>()("CodexAccountResources") {}

export const CodexAccountResourcesLive = (configDir: string) =>
	Layer.effect(
		CodexAccountResources,
		Effect.gen(function* () {
			const scopes = yield* AccountResourceScopesTag;
			const directory = yield* AccountDirectory;
			const bus = yield* DaemonEventBusTag;
			const resolveAccount = (id: string) =>
				Effect.gen(function* () {
					const account = (yield* directory.snapshot).accounts.find(
						(account) => account.id === id,
					);
					if (account?.driver === "codex") return account;
					return yield* new WsRpcError({
						message: `Codex account "${id}" is unavailable`,
					});
				});
			return yield* scopes.make((id) =>
				Effect.gen(function* () {
					yield* resolveAccount(id);
					const auth = yield* makeCodexAuth(configDir, resolveAccount, () =>
						PubSub.publish(bus, DaemonEvent.InstancesChanged()).pipe(
							Effect.asVoid,
						),
					);
					return { auth, usage: makeCodexUsageReader(configDir) };
				}),
			);
		}),
	);
