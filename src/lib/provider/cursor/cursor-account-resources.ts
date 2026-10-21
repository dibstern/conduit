import { join } from "node:path";
import { Context, Effect, Layer, Option, PubSub } from "effect";
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
import { makeCursorAuth } from "./cursor-auth.js";
import {
	createCursorSdkPort,
	cursorCredentialStorePath,
} from "./cursor-sdk.js";
import type { CursorSdkPort } from "./sdk-port.js";
import { adoptLegacyCursorCredential } from "./sdk-real.js";

export class CursorAccountResources extends Context.Service<
	CursorAccountResources,
	AccountResourceScopeOwner<
		{
			readonly sdk: CursorSdkPort;
			readonly auth: Effect.Success<ReturnType<typeof makeCursorAuth>>;
		},
		WsRpcError
	>
>()("CursorAccountResources") {}

export const CursorAccountResourcesLive = (
	configDir: string,
	legacyStorePath?: string,
) =>
	Layer.effect(
		CursorAccountResources,
		Effect.gen(function* () {
			const scopes = yield* AccountResourceScopesTag;
			const directory = yield* AccountDirectory;
			const bus = yield* DaemonEventBusTag;
			const legacyDefault = yield* directory.defaultFor("cursor");
			yield* Effect.tryPromise({
				try: () =>
					adoptLegacyCursorCredential(
						cursorCredentialStorePath(
							Option.isSome(legacyDefault)
								? legacyDefault.value.id
								: "__cursor_login__",
							configDir,
						),
						join(configDir, "cursor", "legacy-auth-adopted"),
						legacyStorePath,
					),
				catch: () =>
					new WsRpcError({
						message: "Could not adopt the existing Cursor login",
					}),
			});
			return yield* scopes.make((id) =>
				Effect.gen(function* () {
					const account = (yield* directory.snapshot).accounts.find(
						(account) => account.id === id && account.driver === "cursor",
					);
					if (!account && id !== "__cursor_login__")
						return yield* Effect.fail(
							new WsRpcError({
								message: `Cursor account "${id}" is unavailable`,
							}),
						);
					const sdk = createCursorSdkPort({ id, configDir });
					const auth = yield* makeCursorAuth(
						() =>
							PubSub.publish(bus, DaemonEvent.InstancesChanged()).pipe(
								Effect.asVoid,
							),
						{
							port: sdk,
							env: { ...process.env, ...account?.env },
						},
					);
					return { sdk, auth };
				}),
			);
		}),
	);
