import { Effect, Either, Option } from "effect";
import type { CursorAuthState } from "../../contracts/ws-rpc.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import {
	cursorEnvironmentKey,
	resolveCursorCredential,
} from "./cursor-credential.js";
import { createCursorSdkPort } from "./cursor-sdk.js";

const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1_000;

/** One daemon owns the interactive flow; only the SDK persists credentials. */
export const makeCursorAuth = (
	onChanged: (authenticated: boolean) => Effect.Effect<void, WsRpcError>,
) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const changes = yield* Effect.makeSemaphore(1);
		let sdk: ReturnType<typeof createCursorSdkPort> | undefined;
		const port = () => (sdk ??= createCursorSdkPort());
		let login: CursorAuthState["login"] = { state: "idle" };
		let controller: AbortController | undefined;
		const configuredTimeout = Number(
			process.env["CONDUIT_TEST_CURSOR_LOGIN_TIMEOUT_MS"],
		);
		const timeoutMs =
			process.env["NODE_ENV"] === "test" && configuredTimeout > 0
				? configuredTimeout
				: 10 * 60 * 1_000;
		const read = Effect.gen(function* () {
			const result = yield* Effect.either(
				Effect.tryPromise(async () => {
					const sdk = port();
					const credential = cursorEnvironmentKey(sdk)
						? await resolveCursorCredential(sdk)
						: undefined;
					if (credential?.source === "environment") {
						// SDK status describes only stored login, never an environment key.
						try {
							await sdk.modelsList(credential);
							return {
								source: "environment",
								status: "logged-in",
								expiresSoon: false,
							} as const;
						} catch {
							return {
								source: "environment",
								status: "error",
								expiresSoon: false,
								error:
									"Cursor could not validate the key from the environment. Check CURSOR_API_KEY and refresh status.",
							} as const;
						}
					}
					const status = await sdk.authStatus();
					if (status.status === "logged-out")
						return {
							source: "none",
							status: "logged-out",
							expiresSoon: false,
						} as const;
					return {
						source: "sdk-login",
						status: "logged-in",
						...(status.email === undefined ? {} : { email: status.email }),
						...(status.apiKeyExpiresAtMs === undefined
							? {}
							: { apiKeyExpiresAtMs: status.apiKeyExpiresAtMs }),
						expiresSoon:
							status.apiKeyExpiresAtMs !== undefined &&
							status.apiKeyExpiresAtMs - Date.now() <= EXPIRY_WARNING_MS,
					} as const;
				}).pipe(Effect.timeout("15 seconds")),
			);
			const state: CursorAuthState = {
				...(Either.isRight(result)
					? result.right
					: {
							source: sdk && cursorEnvironmentKey(sdk) ? "environment" : "none",
							status: "error",
							expiresSoon: false,
							error:
								"Cursor authentication could not be checked. Try logging in again.",
						}),
				login,
			};
			return state;
		});
		const cancel = Effect.sync(() => {
			if (login.state !== "pending") return;
			login = { state: "cancelled" };
			controller?.abort();
			controller = undefined;
		});
		yield* Effect.addFinalizer(() => cancel);
		return {
			read,
			start: changes.withPermits(1)(
				Effect.gen(function* () {
					const current = yield* read;
					if (current.source === "environment" || login.state === "pending")
						return { ...current, login };
					const flow = new AbortController();
					controller = flow;
					const deadlineAtMs = Date.now() + timeoutMs;
					login = { state: "pending", deadlineAtMs };
					const active = () =>
						controller === flow &&
						login.state === "pending" &&
						!flow.signal.aborted;
					yield* Effect.gen(function* () {
						const result = yield* Effect.either(
							Effect.tryPromise((signal) =>
								port().authLogin({
									openBrowser: false,
									apiKeyName: "conduit",
									signal: AbortSignal.any([signal, flow.signal]),
									onLoginUrl: (url) => {
										if (!active() || Date.now() >= deadlineAtMs) return;
										try {
											if (new URL(url).protocol === "https:")
												login = { state: "pending", deadlineAtMs, url };
										} catch {
											/* Ignore an invalid SDK callback. */
										}
									},
								}),
							).pipe(Effect.timeoutOption(timeoutMs)),
						);
						if (!active()) return;
						controller = undefined;
						if (Either.isRight(result) && Option.isNone(result.right)) {
							flow.abort();
							login = {
								state: "timed-out",
								error: "Cursor login timed out. Try again.",
							};
						} else if (Either.isLeft(result)) {
							login = {
								state: "error",
								error: "Cursor login failed. Try again.",
							};
						} else {
							login = { state: "complete" };
							yield* onChanged(true).pipe(
								Effect.catchAll(() =>
									Effect.sync(() => {
										login = {
											state: "error",
											error:
												"Cursor logged in, but the account could not be refreshed. Try refreshing Settings.",
										};
									}),
								),
							);
						}
					}).pipe(Effect.forkIn(scope));
					return { ...current, login };
				}),
			),
			cancel: changes.withPermits(1)(cancel.pipe(Effect.zipRight(read))),
			logout: changes.withPermits(1)(
				Effect.gen(function* () {
					const current = yield* read;
					if (current.source === "environment") return current;
					yield* cancel;
					yield* Effect.tryPromise({
						try: () => port().authLogout(),
						catch: () =>
							new WsRpcError({ message: "Cursor logout failed. Try again." }),
					});
					login = { state: "idle" };
					yield* onChanged(false);
					return yield* read;
				}),
			),
		};
	});
