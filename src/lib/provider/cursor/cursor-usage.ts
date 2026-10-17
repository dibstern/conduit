import { Clock, Deferred, Effect, Option, Schema } from "effect";
import type { CursorUsageBinding } from "../../contracts/account.js";
import type { UsageAccount, UsageRead, UsageReader } from "../usage-reader.js";
import {
	type CursorKeychainRead,
	type CursorUsageToken,
	cursorKeychainTimeout,
	cursorKeychainUnsupported,
	cursorUsageToken,
	makeCursorKeychain,
} from "./cursor-keychain.js";

export type { CursorUsageBinding } from "../../contracts/account.js";

export type CursorUsageSource =
	| "token"
	| "keychain"
	| "can_enable"
	| "unsupported";

const explicitToken = (
	account: Pick<UsageAccount, "id" | "env">,
	env: Readonly<Record<string, string | undefined>>,
) =>
	account.env?.["CURSOR_AUTH_TOKEN"]?.trim() ||
	env["CURSOR_AUTH_TOKEN"]?.trim();

export const cursorUsageSource = (
	account: Pick<UsageAccount, "id" | "env">,
	binding: CursorUsageBinding | undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): CursorUsageSource =>
	explicitToken(account, env)
		? "token"
		: binding?.accountId === account.id
			? "keychain"
			: makeCursorKeychain(env).supported
				? "can_enable"
				: "unsupported";

const DashboardResponseSchema = Schema.Struct({
	billingCycleEnd: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	planUsage: Schema.optional(
		Schema.Struct({ totalPercentUsed: Schema.optional(Schema.Number) }),
	),
});

const unavailable = (reason: string): UsageRead => ({
	status: "unavailable",
	windows: [],
	reason,
});
const waiting: UsageRead = {
	status: "unknown",
	windows: [],
	reason: "Waiting for Keychain access on this Mac",
};
const mismatch =
	"The Cursor CLI is now signed in to a different account. Enable again to use it.";

export const makeCursorUsage = (options: {
	readonly getBinding: () => CursorUsageBinding | undefined;
	readonly saveBinding: (
		binding: CursorUsageBinding | undefined,
	) => Effect.Effect<void, unknown>;
	readonly env?: Readonly<Record<string, string | undefined>>;
}) => {
	const env = options.env ?? process.env;
	const keychain = makeCursorKeychain(env);
	const endpoint =
		(env["NODE_ENV"] === "test"
			? env["CONDUIT_TEST_CURSOR_DASHBOARD_URL"]?.trim()
			: undefined) ||
		"https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
	let memory = Option.none<CursorUsageToken>();
	let pending = Option.none<Deferred.Deferred<CursorKeychainRead>>();
	let requestedAccount: string | undefined;
	const bindingLock = Effect.unsafeMakeSemaphore(1);
	const cached = new Map<
		string,
		{ credential: CursorUsageToken; until: number; reading: UsageRead }
	>();
	const source = (
		account: Pick<UsageAccount, "id" | "env">,
	): CursorUsageSource => cursorUsageSource(account, options.getBinding(), env);

	// A waiting Usage fiber can time out without cancelling the user's prompt.
	const startKeychainRead = Effect.uninterruptible(
		Effect.gen(function* () {
			if (Option.isSome(pending)) return pending.value;
			const done = yield* Deferred.make<CursorKeychainRead>();
			pending = Option.some(done);
			yield* keychain.read.pipe(
				Effect.timeoutTo({
					duration: "60 seconds",
					onTimeout: (): CursorKeychainRead => ({
						reason: cursorKeychainTimeout,
					}),
					onSuccess: (result) => result,
				}),
				Effect.tap((result) =>
					Effect.sync(() => {
						if (result.credential && options.getBinding())
							memory = Option.some(result.credential);
					}),
				),
				Effect.onExit((exit) =>
					Effect.sync(() => {
						pending = Option.none();
					}).pipe(Effect.zipRight(Deferred.done(done, exit))),
				),
				Effect.interruptible,
				Effect.forkDaemon,
			);
			return done;
		}),
	);

	const keychainCredential = (accountId: string, refresh = false) =>
		Effect.gen(function* () {
			const binding = options.getBinding();
			if (binding?.accountId !== accountId)
				return { reason: "Enable Cursor usage or set CURSOR_AUTH_TOKEN." };
			if (refresh) memory = Option.none();
			const result = Option.isSome(memory)
				? { credential: memory.value }
				: yield* startKeychainRead.pipe(
						Effect.flatMap((done) => Deferred.await(done)),
						Effect.timeoutOption("250 millis"),
						Effect.map((result) =>
							Option.isSome(result) ? result.value : { waiting: true },
						),
					);
			if ("credential" in result && result.credential) {
				const current = options.getBinding();
				if (
					current?.accountId !== accountId ||
					result.credential.subjectHash !== current.subjectHash
				)
					return { reason: mismatch };
			}
			return result;
		});

	const dashboard = (credential: CursorUsageToken) =>
		Effect.tryPromise({
			try: (signal) =>
				fetch(endpoint, {
					method: "POST",
					headers: {
						authorization: `Bearer ${credential.token}`,
						"content-type": "application/json",
						"connect-protocol-version": "1",
						"x-cursor-client-type": "cli",
					},
					body: "{}",
					signal,
				}),
			catch: () => "Cursor usage could not be reached.",
		}).pipe(
			Effect.flatMap((response) => {
				if (!response.ok)
					return Effect.succeed({
						authFailed: response.status === 401 || response.status === 403,
						reading: unavailable(
							response.status === 401 || response.status === 403
								? "Cursor usage authentication failed. Enable again or set CURSOR_AUTH_TOKEN."
								: "Cursor usage is temporarily unavailable.",
						),
					});
				return Effect.tryPromise({
					try: () => response.json(),
					catch: () => "Cursor usage returned an invalid response.",
				}).pipe(
					Effect.flatMap(Schema.decodeUnknown(DashboardResponseSchema)),
					Effect.map((body) => {
						const percent = body.planUsage?.totalPercentUsed;
						if (percent === undefined || !Number.isFinite(percent))
							return {
								authFailed: false,
								reading: unavailable(
									"Cursor did not return monthly plan usage.",
								),
							};
						const reset = Number(body.billingCycleEnd);
						const date = new Date(reset);
						const resetsAt =
							reset > 0 &&
							Number.isFinite(reset) &&
							Number.isFinite(date.getTime())
								? date.toISOString()
								: undefined;
						const utilization = Math.min(100, Math.max(0, percent));
						return {
							authFailed: false,
							reading: {
								status: utilization >= 100 ? "limited" : "available",
								windows: [
									{
										kind: "month",
										utilization,
										...(resetsAt ? { resetsAt } : {}),
									},
								],
							} satisfies UsageRead,
						};
					}),
				);
			}),
			Effect.catchAll(() =>
				Effect.succeed({
					authFailed: false,
					reading: unavailable("Cursor usage could not be read. Try again."),
				}),
			),
		);

	const reader: UsageReader = {
		read: (account) =>
			Effect.gen(function* () {
				const explicit = explicitToken(account, env);
				const result = explicit
					? { credential: cursorUsageToken(explicit) }
					: yield* keychainCredential(account.id);
				if ("waiting" in result) return waiting;
				if (!result.credential) return unavailable(result.reason);
				let credential = result.credential;
				const now = yield* Clock.currentTimeMillis;
				const previous = cached.get(account.id);
				if (
					previous &&
					previous.credential.token === credential.token &&
					previous.until > now
				)
					return previous.reading;
				let response = yield* dashboard(credential);
				if (response.authFailed && !explicit) {
					cached.delete(account.id);
					const replacement = yield* keychainCredential(account.id, true);
					if ("waiting" in replacement) return waiting;
					if (!replacement.credential) return unavailable(replacement.reason);
					credential = replacement.credential;
					response = yield* dashboard(credential);
				}
				if (
					response.reading.status === "available" ||
					response.reading.status === "limited"
				)
					cached.set(account.id, {
						credential,
						until: (yield* Clock.currentTimeMillis) + 60_000,
						reading: response.reading,
					});
				return response.reading;
			}),
	};

	return {
		reader,
		source,
		eligible: (account: Pick<UsageAccount, "id" | "env">) =>
			Boolean(explicitToken(account, env)) ||
			options.getBinding()?.accountId === account.id,
		setKeychain: (accountId: string, enabled: boolean) =>
			Effect.gen(function* () {
				if (!enabled) {
					if (requestedAccount === accountId) requestedAccount = undefined;
					return yield* bindingLock.withPermits(1)(
						Effect.uninterruptible(
							Effect.gen(function* () {
								if (
									requestedAccount !== accountId &&
									options.getBinding()?.accountId === accountId
								) {
									yield* options.saveBinding(undefined);
									memory = Option.none();
									cached.delete(accountId);
								}
								return { enabled: false };
							}),
						),
					);
				}
				if (!keychain.supported)
					return { enabled: false, reason: cursorKeychainUnsupported };
				requestedAccount = accountId;
				const done = yield* startKeychainRead;
				const result = yield* Deferred.await(done);
				if (!result.credential || !result.credential.subjectHash)
					return {
						enabled: false,
						reason: result.reason ?? "The Cursor CLI login could not be read.",
					};
				const subjectHash = result.credential.subjectHash;
				const credential = result.credential;
				return yield* bindingLock.withPermits(1)(
					Effect.uninterruptible(
						Effect.gen(function* () {
							if (requestedAccount !== accountId)
								return {
									enabled: false,
									reason: "Cursor usage settings changed. Try again.",
								};
							yield* options.saveBinding({ accountId, subjectHash });
							memory = Option.some(credential);
							cached.clear();
							return { enabled: true };
						}),
					),
				);
			}).pipe(
				Effect.catchAll(() =>
					Effect.succeed({
						enabled: false,
						reason: "Cursor usage settings could not be saved.",
					}),
				),
			),
	};
};
