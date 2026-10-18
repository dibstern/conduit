import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Context, Data, Effect, Option, Redacted, Schema } from "effect";
import {
	DEFAULT_MESSAGE_SURFACING_SETTINGS,
	type MessageSurfacingPatch,
	MessageSurfacingSettingsSchema,
	type MessageSurfacingStatus,
} from "../../../contracts/message-surfacing.js";

export class MessageSurfacingSettingsError extends Data.TaggedError(
	"MessageSurfacingSettingsError",
)<{
	readonly message: string;
}> {}

export interface MessageSurfacingSettingsService {
	readonly get: Effect.Effect<MessageSurfacingStatus>;
	readonly update: (
		patch: MessageSurfacingPatch,
	) => Effect.Effect<MessageSurfacingStatus, MessageSurfacingSettingsError>;
	/** Future Jev calls share the active gate and persistent 401 handling. */
	readonly post: (
		body: unknown,
	) => Effect.Effect<Response, MessageSurfacingSettingsError>;
}

export class MessageSurfacingSettings extends Context.Tag(
	"MessageSurfacingSettings",
)<MessageSurfacingSettings, MessageSurfacingSettingsService>() {}

export interface MessageSurfacingSettingsOptions {
	readonly env?: {
		readonly TYPESAFE_API_KEY?: string;
		readonly TYPESAFE_BASE_URL?: string;
	};
	readonly transport?: (url: string, init: RequestInit) => Promise<Response>;
}

const SnapshotSchema = Schema.Struct({
	settings: MessageSurfacingSettingsSchema,
	apiKey: Schema.OptionFromNullOr(Schema.Redacted(Schema.String)),
	keyState: Schema.Literal("none", "valid", "invalid"),
	invalidEnvKeyHash: Schema.OptionFromNullOr(Schema.String),
});
type Snapshot = typeof SnapshotSchema.Type;

export const isSurfacingLoopback = (address: string): boolean => {
	const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
	return (
		address === "::1" ||
		address === "[::1]" ||
		(isIP(ipv4) === 4 && ipv4.startsWith("127."))
	);
};

/** One private atomic snapshot keeps preferences and credential status consistent. */
export const makeMessageSurfacingSettings = (
	configDir: string,
	options: MessageSurfacingSettingsOptions = {},
) =>
	Effect.gen(function* () {
		const directory = join(configDir, "credentials");
		const filename = join(directory, "typesafe");
		const env = options.env ?? process.env;
		const envKey = Option.fromNullable(
			env.TYPESAFE_API_KEY?.trim() || undefined,
		).pipe(Option.map(Redacted.make));
		const envKeyHash = Option.map(envKey, (key) =>
			createHash("sha256").update(Redacted.value(key)).digest("hex"),
		);
		const baseUrl = env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
		const transport = options.transport ?? fetch;
		const lock = yield* Effect.makeSemaphore(1);
		let current: Snapshot = yield* Effect.tryPromise({
			try: async () => {
				let content: string;
				try {
					content = await readFile(filename, "utf8");
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					) {
						return {
							settings: DEFAULT_MESSAGE_SURFACING_SETTINGS,
							apiKey: Option.none<Redacted.Redacted<string>>(),
							keyState: "none" as const,
							invalidEnvKeyHash: Option.none<string>(),
						};
					}
					throw error;
				}
				await chmod(directory, 0o700);
				await chmod(filename, 0o600);
				return Schema.decodeUnknownSync(Schema.parseJson(SnapshotSchema))(
					content,
				);
			},
			// Foreign errors can contain a credential or response body.
			catch: () =>
				new MessageSurfacingSettingsError({
					message: "Could not load message surfacing settings",
				}),
		});
		const save = (next: Snapshot) =>
			Effect.suspend(() => {
				const temporary = join(directory, `.typesafe.tmp.${randomUUID()}`);
				return Effect.tryPromise({
					try: async () => {
						await mkdir(directory, { recursive: true, mode: 0o700 });
						await chmod(directory, 0o700);
						await writeFile(
							temporary,
							Schema.encodeSync(Schema.parseJson(SnapshotSchema))(next),
							{ encoding: "utf8", mode: 0o600, flag: "wx" },
						);
						await rename(temporary, filename);
						current = next;
					},
					catch: () =>
						new MessageSurfacingSettingsError({
							message: "Could not save message surfacing settings",
						}),
				}).pipe(
					Effect.ensuring(
						Effect.tryPromise(() => rm(temporary, { force: true })).pipe(
							Effect.ignore,
						),
					),
				);
			});
		const status = (): MessageSurfacingStatus => {
			const source = Option.isSome(envKey)
				? "env"
				: Option.isSome(current.apiKey)
					? "stored"
					: "none";
			const rejected =
				source === "env"
					? Option.isSome(current.invalidEnvKeyHash) &&
						Option.isSome(envKeyHash) &&
						current.invalidEnvKeyHash.value === envKeyHash.value
					: source === "stored" && current.keyState === "invalid";
			return {
				...current.settings,
				recap: { ...current.settings.recap },
				active: current.settings.enabled && source !== "none" && !rejected,
				key: { source, rejected },
			};
		};
		const send = (key: Redacted.Redacted<string>, body: unknown) =>
			Effect.gen(function* () {
				const url = yield* Effect.try({
					try: () => new URL(`${baseUrl.replace(/\/$/, "")}/v1/systemone`),
					catch: () =>
						new MessageSurfacingSettingsError({
							message: "Invalid TypeSafe base URL",
						}),
				});
				if (
					url.username ||
					url.password ||
					url.search ||
					url.hash ||
					!(
						url.protocol === "https:" ||
						(url.protocol === "http:" &&
							(url.hostname === "localhost" ||
								isSurfacingLoopback(url.hostname)))
					)
				) {
					return yield* new MessageSurfacingSettingsError({
						message: "TypeSafe requires TLS or loopback",
					});
				}
				return yield* Effect.tryPromise({
					try: (signal) =>
						transport(url.href, {
							method: "POST",
							headers: {
								authorization: `Bearer ${Redacted.value(key)}`,
								"content-type": "application/json",
							},
							body: JSON.stringify(body),
							redirect: "error",
							signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
						}),
					catch: () =>
						new MessageSurfacingSettingsError({
							message: "TypeSafe request failed",
						}),
				});
			});
		const update: MessageSurfacingSettingsService["update"] = (patch) =>
			lock.withPermits(1)(
				Effect.gen(function* () {
					if (patch.apiKey !== undefined && Option.isSome(envKey)) {
						return yield* new MessageSurfacingSettingsError({
							message: "TypeSafe key is set by environment",
						});
					}
					let apiKey = current.apiKey;
					let keyState = current.keyState;
					if (patch.apiKey === null) {
						apiKey = Option.none();
						keyState = "none";
					} else if (patch.apiKey !== undefined) {
						if (!patch.apiKey.trim())
							return yield* new MessageSurfacingSettingsError({
								message: "TypeSafe key must not be empty",
							});
						const key = Redacted.make(patch.apiKey.trim());
						const response = yield* send(key, {
							model: "jev-1.13.0",
							state: "ok",
							questions: {
								ok: {
									type: "noul",
									instructions: "Is the state ok?",
									criteria: { true: "ok", false: "not ok" },
								},
							},
						});
						yield* Effect.tryPromise(async () => response.body?.cancel()).pipe(
							Effect.ignore,
						);
						if (!response.ok)
							return yield* new MessageSurfacingSettingsError({
								message:
									response.status === 401
										? "TypeSafe rejected the key"
										: "TypeSafe key validation failed",
							});
						apiKey = Option.some(key);
						keyState = "valid";
					}
					yield* save({
						...current,
						settings: {
							enabled: patch.enabled ?? current.settings.enabled,
							defaultLevel: patch.defaultLevel ?? current.settings.defaultLevel,
							turnsOpen: patch.turnsOpen ?? current.settings.turnsOpen,
							recap: {
								model: patch.recap?.model ?? current.settings.recap.model,
								when: patch.recap?.when ?? current.settings.recap.when,
							},
							tuningModel: patch.tuningModel ?? current.settings.tuningModel,
						},
						apiKey,
						keyState,
					});
					return status();
				}).pipe(Effect.uninterruptible),
			);
		const post: MessageSurfacingSettingsService["post"] = (body) =>
			Effect.gen(function* () {
				if (!status().active)
					return yield* new MessageSurfacingSettingsError({
						message: "Message surfacing is inactive",
					});
				const key = Option.orElse(envKey, () => current.apiKey);
				if (Option.isNone(key))
					return yield* new MessageSurfacingSettingsError({
						message: "Message surfacing is inactive",
					});
				const response = yield* send(key.value, body);
				if (response.status === 401) {
					return yield* Effect.gen(function* () {
						yield* Effect.tryPromise(async () => response.body?.cancel()).pipe(
							Effect.ignore,
						);
						yield* lock.withPermits(1)(
							Effect.gen(function* () {
								// A response for a replaced credential must not invalidate its successor.
								if (Option.isSome(envKey))
									current = { ...current, invalidEnvKeyHash: envKeyHash };
								else if (
									Option.isSome(current.apiKey) &&
									current.apiKey.value === key.value
								)
									current = { ...current, keyState: "invalid" };
								else return;
								// Keep calls stopped even if persisting the rejection fails.
								yield* save(current);
							}),
						);
						return yield* new MessageSurfacingSettingsError({
							message: "TypeSafe rejected the key",
						});
					}).pipe(Effect.uninterruptible);
				}
				return response;
			});
		return {
			get: Effect.sync(status),
			update,
			post,
		} satisfies MessageSurfacingSettingsService;
	});
