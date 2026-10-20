import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import { Effect, Layer, Option, Ref } from "effect";
import type { Avatar } from "../../../contracts/user-avatar.js";
import { AccountPicture } from "../Services/account-picture.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../Services/daemon-config-ref.js";
import { UserAvatar } from "../Services/user-avatar.js";

const execFileAsync = promisify(execFile);
const accountName = Effect.try(() => userInfo().username.trim() || "?").pipe(
	Effect.orElseSucceed(() => "?"),
);
const globalName = Effect.tryPromise(async () => {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			["GIT_DIR", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_WORK_TREE"].includes(
				key,
			) ||
			/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)
		)
			delete env[key];
	}
	const { stdout } = await execFileAsync(
		"git",
		["config", "--global", "--get", "user.name"],
		{
			timeout: 2000,
			maxBuffer: 16 * 1024,
			encoding: "utf8",
			env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
		},
	);
	return stdout.trim();
}).pipe(
	Effect.orElseSucceed(() => ""),
	Effect.flatMap((name) => (name ? Effect.succeed(name) : accountName)),
);

export const UserAvatarLive = Layer.effect(
	UserAvatar,
	Effect.gen(function* () {
		const context = yield* Effect.context<DaemonConfigRefTag>();
		const configRef = yield* DaemonConfigRefTag;
		const persistence = yield* ConfigPersistenceTag;
		const picture = yield* AccountPicture;
		const get: Effect.Effect<Avatar> = Effect.gen(function* () {
			const name = yield* globalName;
			const macPicture = yield* picture.read;
			const config = yield* Ref.get(configRef);
			return {
				choice: config.avatar ?? null,
				name,
				macPicture: Option.isSome(macPicture)
					? `data:image/jpeg;base64,${Buffer.from(macPicture.value).toString("base64")}`
					: null,
			};
		});
		return UserAvatar.of({
			get,
			set: (choice) =>
				Effect.gen(function* () {
					yield* commitDaemonRuntimeConfig((config) => ({
						...config,
						avatar: choice,
					}));
					yield* persistence.requestSave;
					yield* persistence.flush;
					return yield* get;
				}).pipe(Effect.provide(context)),
		});
	}),
);
