import { join } from "node:path";
import { Context, Effect, Layer, Option, PubSub } from "effect";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import { AccountDirectory } from "../../domain/daemon/Services/account-directory.js";
import { AccountResourceScopesTag } from "../../domain/daemon/Services/account-resource-scopes.js";
import {
	DaemonEvent,
	DaemonEventBusTag,
} from "../../domain/daemon/Services/daemon-pubsub.js";
import { makeCursorAuth } from "./cursor-auth.js";
import {
	type CursorBackendUrl,
	type CursorCredentialLookup,
	type CursorCredentialOwner,
	cursorBackendUrl,
	resolveCursorCredential,
} from "./cursor-credential.js";
import {
	createCursorSdkPort,
	cursorCredentialStorePath,
} from "./cursor-sdk.js";
import type { CursorSdkPort } from "./sdk-port.js";
import { adoptLegacyCursorCredential } from "./sdk-real.js";

export interface CursorAccountResource {
	readonly owner: CursorCredentialOwner;
	readonly sdk: CursorSdkPort;
	readonly auth: Effect.Success<ReturnType<typeof makeCursorAuth>>;
	readonly credential: Effect.Effect<CursorCredentialLookup, WsRpcError>;
}

export class CursorAccountResources extends Context.Service<
	CursorAccountResources,
	{
		readonly backendUrl: CursorBackendUrl;
		readonly use: <B, E, R>(
			id: string | Extract<CursorCredentialOwner, { _tag: "LoginSlot" }>,
			work: (resource: CursorAccountResource) => Effect.Effect<B, E, R>,
		) => Effect.Effect<B, E | WsRpcError, R>;
	}
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
			const backendUrl = cursorBackendUrl(
				process.env["CURSOR_BACKEND_URL"] ?? "https://api2.cursor.sh",
			);
			const loginSlot = { _tag: "LoginSlot" } as const;
			const compatibilityStorePath = yield* Effect.tryPromise({
				try: () =>
					adoptLegacyCursorCredential(
						cursorCredentialStorePath(
							Option.isSome(legacyDefault) ? legacyDefault.value.id : loginSlot,
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
			const resources = yield* scopes.make((id) =>
				Effect.gen(function* () {
					const account = (yield* directory.snapshot).accounts.find(
						(account) => account.id === id && account.driver === "cursor",
					);
					if (!account && id !== "")
						return yield* Effect.fail(
							new WsRpcError({
								message: `Cursor account "${id}" is unavailable`,
							}),
						);
					const owner: CursorCredentialOwner =
						account?.driver === "cursor"
							? {
									_tag: "Account",
									account,
									launchEnv:
										cursorCredentialStorePath(account.id, configDir) ===
										compatibilityStorePath,
								}
							: loginSlot;
					const sdk = createCursorSdkPort({
						id: owner._tag === "Account" ? owner.account.id : owner,
						configDir,
					});
					const credential = Effect.tryPromise({
						try: async () => {
							const launchEnv =
								owner._tag === "Account"
									? owner.launchEnv
									: cursorCredentialStorePath(owner, configDir) ===
										compatibilityStorePath;
							let envKey =
								owner._tag === "Account" &&
								owner.account.env?.["CURSOR_API_KEY"] !== undefined
									? owner.account.env["CURSOR_API_KEY"]
									: launchEnv
										? process.env["CURSOR_API_KEY"]
										: undefined;
							// Replay must never consume a developer's real credential.
							if (
								sdk.replay &&
								!(
									process.env["NODE_ENV"] === "test" &&
									/^\[REDACTED(?::[a-zA-Z0-9_-]+)?\]$/.test(envKey ?? "")
								)
							)
								envKey = undefined;
							return resolveCursorCredential(
								envKey,
								envKey?.trim() ? undefined : await sdk.storedCredential(),
								backendUrl,
								Date.now(),
							);
						},
						catch: () =>
							new WsRpcError({ message: "Cursor credential lookup failed" }),
					});
					const auth = yield* makeCursorAuth(
						() =>
							PubSub.publish(bus, DaemonEvent.InstancesChanged()).pipe(
								Effect.asVoid,
							),
						{
							port: sdk,
							credential,
						},
					);
					return { owner, sdk, auth, credential };
				}),
			);
			return {
				backendUrl,
				use: (id, work) =>
					resources.use(typeof id === "string" ? id : "", work),
			};
		}),
	);
