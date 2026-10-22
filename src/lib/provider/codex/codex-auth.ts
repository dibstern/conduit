import { Deferred, Effect, Option, Result, Semaphore, Stream } from "effect";
import type { CodexAccount } from "../../contracts/account.js";
import type { CodexAuthState } from "../../contracts/ws-rpc.js";
import { WsRpcError } from "../../contracts/ws-rpc.js";
import type { AppServerClient } from "./app-server/client.js";
import {
	AccountReadResponseSchema,
	CancelLoginAccountResponseSchema,
	decodeNotification,
	LoginAccountResponseSchema,
	LogoutAccountResponseSchema,
} from "./app-server/protocol.js";
import {
	invalidateCodexAuth,
	openCodexDiscoveryClient,
} from "./codex-discovery.js";
import { CODEX_CREDENTIAL_ENV, prepareCodexAccount } from "./codex-home.js";

type LoginMethod = "browser" | "device-code";

interface LoginFlow {
	readonly client: AppServerClient;
	readonly home: string;
	readonly loginId: string;
	readonly stopped: Deferred.Deferred<void>;
}

const initialState = (accountId: string): CodexAuthState => ({
	accountId,
	source: "none",
	status: "logged-out",
	login: { state: "idle" },
});

/** A login owns one scoped app-server; Codex alone reads and writes credentials. */
export const makeCodexAuth = (
	configDir: string,
	resolveAccount: (
		accountId: string,
	) => Effect.Effect<CodexAccount, WsRpcError>,
	onChanged: (accountId: string) => Effect.Effect<void, WsRpcError>,
) =>
	Effect.gen(function* () {
		const scope = yield* Effect.scope;
		const changes = yield* Semaphore.make(1);
		const states = new Map<string, CodexAuthState>();
		const flows = new Map<string, LoginFlow>();
		const current = (accountId: string) =>
			states.get(accountId) ?? initialState(accountId);
		const configuredTimeout = Number(
			process.env["CONDUIT_TEST_CODEX_LOGIN_TIMEOUT_MS"],
		);
		const timeoutMs =
			process.env["NODE_ENV"] === "test" && configuredTimeout > 0
				? configuredTimeout
				: 10 * 60 * 1_000;
		const recordAccount = (
			accountId: string,
			response: typeof AccountReadResponseSchema.Type,
			env: NodeJS.ProcessEnv,
		) => {
			const account = response.account;
			const state: CodexAuthState = {
				accountId,
				source: account
					? account.type === "apiKey" &&
						CODEX_CREDENTIAL_ENV.some((key) => Boolean(env[key]))
						? "environment"
						: "codex-login"
					: "none",
				status: account ? "logged-in" : "logged-out",
				...(account?.email ? { email: account.email } : {}),
				login: current(accountId).login,
			};
			states.set(accountId, state);
			return state;
		};
		const setLogin = (accountId: string, login: CodexAuthState["login"]) => {
			const state = { ...current(accountId), login };
			states.set(accountId, state);
			return state;
		};
		const read = (accountId: string) =>
			Effect.gen(function* () {
				const account = yield* resolveAccount(accountId);
				if (flows.has(accountId)) return current(accountId);
				const result = yield* Effect.result(
					Effect.scoped(
						Effect.gen(function* () {
							const prepared = yield* prepareCodexAccount(account, configDir);
							const client = yield* openCodexDiscoveryClient(
								prepared.home,
								prepared.env,
								"codex-auth",
								true,
							);
							const response = yield* client.request(
								"account/read",
								{ refreshToken: false },
								AccountReadResponseSchema,
							);
							return recordAccount(accountId, response, prepared.env);
						}),
					).pipe(Effect.timeout("15 seconds")),
				);
				if (Result.isSuccess(result)) return result.success;
				const state: CodexAuthState = {
					...current(accountId),
					status: "error",
					error: "Codex authentication could not be checked. Try again.",
				};
				states.set(accountId, state);
				return state;
			});
		const cancelFlow = (accountId: string) =>
			Effect.gen(function* () {
				const flow = flows.get(accountId);
				if (!flow) return current(accountId);
				const result = yield* Effect.result(
					flow.client
						.request(
							"account/login/cancel",
							{ loginId: flow.loginId },
							CancelLoginAccountResponseSchema,
						)
						.pipe(Effect.timeout("5 seconds")),
				);
				flows.delete(accountId);
				yield* Deferred.succeed(flow.stopped, undefined);
				return setLogin(
					accountId,
					Result.isSuccess(result)
						? { state: "cancelled" }
						: { state: "error", error: "Codex login could not be cancelled." },
				);
			});
		return {
			read: (accountId: string) => changes.withPermits(1)(read(accountId)),
			start: (accountId: string, method: LoginMethod) =>
				changes.withPermits(1)(
					Effect.gen(function* () {
						const account = yield* resolveAccount(accountId);
						if (flows.has(accountId)) return current(accountId);
						const ready = yield* Deferred.make<CodexAuthState>();
						yield* Effect.scoped(
							Effect.gen(function* () {
								const prepared = yield* prepareCodexAccount(account, configDir);
								const client = yield* openCodexDiscoveryClient(
									prepared.home,
									prepared.env,
									"codex-login",
									true,
								).pipe(Effect.timeout("15 seconds"));
								const response = yield* client
									.request(
										"account/read",
										{ refreshToken: false },
										AccountReadResponseSchema,
									)
									.pipe(Effect.timeout("15 seconds"));
								recordAccount(accountId, response, prepared.env);
								const started = yield* client
									.request(
										"account/login/start",
										{
											type:
												method === "browser" ? "chatgpt" : "chatgptDeviceCode",
										},
										LoginAccountResponseSchema,
									)
									.pipe(Effect.timeout("30 seconds"));
								const url =
									started.type === "chatgpt"
										? started.authUrl
										: started.verificationUrl;
								const loginUrl = yield* Effect.try({
									try: () => new URL(url),
									catch: () =>
										new WsRpcError({
											message: "Codex returned an invalid login URL.",
										}),
								});
								if (loginUrl.protocol !== "https:") {
									return yield* Effect.fail(
										new WsRpcError({
											message: "Codex returned an invalid login URL.",
										}),
									);
								}
								const flow: LoginFlow = {
									client,
									home: prepared.home,
									loginId: started.loginId,
									stopped: yield* Deferred.make<void>(),
								};
								flows.set(accountId, flow);
								yield* Effect.addFinalizer(() =>
									Effect.gen(function* () {
										if (flows.get(accountId) !== flow) return;
										flows.delete(accountId);
										yield* client
											.request(
												"account/login/cancel",
												{ loginId: flow.loginId },
												CancelLoginAccountResponseSchema,
											)
											.pipe(Effect.timeout("5 seconds"), Effect.ignore);
									}),
								);
								const pending = setLogin(accountId, {
									state: "pending",
									method,
									url,
									loginId: flow.loginId,
									deadlineAtMs: Date.now() + timeoutMs,
									...(started.type === "chatgptDeviceCode"
										? {
												userCode: started.userCode,
												verificationUrl: started.verificationUrl,
											}
										: {}),
								});
								yield* Deferred.succeed(ready, pending);
								const completed = yield* client.notifications.pipe(
									Stream.map(decodeNotification),
									Stream.tap((notification) =>
										Effect.sync(() => {
											if (
												notification._tag === "known" &&
												notification.method === "account/updated"
											)
												invalidateCodexAuth(flow.home);
										}),
									),
									Stream.filter(
										(notification) =>
											notification._tag === "known" &&
											notification.method === "account/login/completed" &&
											(notification.params.loginId == null ||
												notification.params.loginId === flow.loginId),
									),
									Stream.runHead,
									Effect.timeoutOption(timeoutMs),
									Effect.raceFirst(
										Deferred.await(flow.stopped).pipe(Effect.as(Option.none())),
									),
								);
								yield* changes.withPermits(1)(
									Effect.gen(function* () {
										if (flows.get(accountId) !== flow) return;
										if (Option.isNone(completed)) {
											setLogin(accountId, {
												state: "timed-out",
												error: "Codex login timed out. Try again.",
											});
											return;
										}
										const notification = completed.value;
										if (
											Option.isNone(notification) ||
											notification.value._tag !== "known" ||
											notification.value.method !== "account/login/completed"
										) {
											return yield* Effect.fail(
												new WsRpcError({
													message: "Codex login ended before completion.",
												}),
											);
										}
										if (!notification.value.params.success) {
											flows.delete(accountId);
											setLogin(accountId, {
												state: "error",
												error:
													notification.value.params.error ||
													"Codex login failed. Try again.",
											});
											return;
										}
										invalidateCodexAuth(flow.home);
										const authenticated = yield* client
											.request(
												"account/read",
												{ refreshToken: false },
												AccountReadResponseSchema,
											)
											.pipe(Effect.timeout("15 seconds"));
										recordAccount(accountId, authenticated, prepared.env);
										flows.delete(accountId);
										setLogin(
											accountId,
											authenticated.account
												? { state: "complete" }
												: {
														state: "error",
														error:
															"Codex did not save the completed login. Try again.",
													},
										);
										yield* onChanged(accountId);
									}),
								);
							}),
						).pipe(
							Effect.catch(() =>
								Effect.sync(() =>
									setLogin(accountId, {
										state: "error",
										error: "Codex login failed. Try again.",
									}),
								),
							),
							Effect.ensuring(
								Effect.suspend(() =>
									Deferred.succeed(ready, current(accountId)),
								),
							),
							Effect.forkIn(scope),
						);
						return yield* Deferred.await(ready);
					}),
				),
			cancel: (accountId: string) =>
				changes.withPermits(1)(
					resolveAccount(accountId).pipe(Effect.andThen(cancelFlow(accountId))),
				),
			logout: (accountId: string) =>
				changes.withPermits(1)(
					Effect.gen(function* () {
						const account = yield* resolveAccount(accountId);
						yield* cancelFlow(accountId);
						const prepared = yield* prepareCodexAccount(
							account,
							configDir,
						).pipe(
							Effect.mapError(
								() =>
									new WsRpcError({
										message: "Codex account home is unavailable.",
									}),
							),
						);
						const response = yield* Effect.scoped(
							Effect.gen(function* () {
								const client = yield* openCodexDiscoveryClient(
									prepared.home,
									prepared.env,
									"codex-logout",
									true,
								);
								yield* client.request(
									"account/logout",
									{},
									LogoutAccountResponseSchema,
								);
								invalidateCodexAuth(prepared.home);
								return yield* client.request(
									"account/read",
									{ refreshToken: false },
									AccountReadResponseSchema,
								);
							}),
						).pipe(
							Effect.timeout("15 seconds"),
							Effect.mapError(
								() =>
									new WsRpcError({
										message: "Codex logout failed. Try again.",
									}),
							),
						);
						recordAccount(accountId, response, prepared.env);
						setLogin(accountId, { state: "idle" });
						yield* onChanged(accountId);
						return current(accountId);
					}),
				),
		};
	});
