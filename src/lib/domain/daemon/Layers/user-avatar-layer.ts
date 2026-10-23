import { userInfo } from "node:os";
import { Effect, Layer, Option, Ref, Semaphore } from "effect";
import type { Avatar } from "../../../contracts/user-avatar.js";
import { AccountPicture } from "../Services/account-picture.js";
import { ConfigPersistenceTag } from "../Services/config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefTag,
} from "../Services/daemon-config-ref.js";
import { Subprocess, type SubprocessService } from "../Services/subprocess.js";
import { UserAvatar } from "../Services/user-avatar.js";

const accountName = Effect.try(() => userInfo().username.trim() || "?").pipe(
	Effect.orElseSucceed(() => "?"),
);
const globalName = (subprocess: SubprocessService) =>
	Effect.suspend(() => {
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (
				[
					"GIT_DIR",
					"GIT_INDEX_FILE",
					"GIT_COMMON_DIR",
					"GIT_WORK_TREE",
				].includes(key) ||
				/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)
			)
				delete env[key];
		}
		return subprocess
			.run("git", ["config", "--global", "--get", "user.name"], {
				timeoutMs: 2000,
				maxBuffer: 16 * 1024,
				env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
			})
			.pipe(
				Effect.map(({ stdout, exitCode }) =>
					exitCode === 0 ? stdout.trim() : "",
				),
			);
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
		const subprocess = yield* Subprocess;
		const [readName, invalidateName] = yield* Effect.cachedInvalidateWithTTL(
			globalName(subprocess),
			"10 minutes",
		);
		let nameConfig = yield* Ref.get(configRef);
		// Serialize invalidation with reads so settings cannot retain an old lookup.
		const nameLock = yield* Semaphore.make(1);
		const get: Effect.Effect<Avatar> = Effect.gen(function* () {
			const name = yield* nameLock.withPermits(1)(
				Effect.gen(function* () {
					const config = yield* Ref.get(configRef);
					if (config !== nameConfig) {
						yield* invalidateName;
						nameConfig = config;
					}
					return yield* readName;
				}),
			);
			const macPicture = yield* picture.read.pipe(
				Effect.map(
					Option.match({
						onNone: () => ({ macPicture: null }),
						onSome: (bytes) => ({
							macPicture: `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`,
						}),
					}),
				),
				// Unreadable this time: leave it out so the browser keeps its copy.
				Effect.catch((error) =>
					Effect.logWarning("Mac account picture unavailable", error).pipe(
						Effect.as({}),
					),
				),
			);
			const config = yield* Ref.get(configRef);
			return { choice: config.avatar ?? null, name, ...macPicture };
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
