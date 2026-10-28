// Failure modes: global git name is missing or overridden by a repository/env;
// old config asks once, a shape seed or other save loses the choice; unavailable
// or changed account photos break reads; invalid choices persist; failed saves
// are acknowledged; a failed photo read is reported as "no picture" and erases
// the browser's copy. The adapter must return only a bounded JPEG or none, and
// repeat reads must not rerun the slow lookup.
// Concurrent identity reads share one lookup; settings and avatar saves, and
// TTL expiry, must refresh it, including a cached account-name fallback.

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
	Context,
	Effect,
	Result as Either,
	Layer,
	Option,
	Schema,
} from "effect";
import { TestClock } from "effect/testing";
import {
	type Avatar,
	AvatarChoiceSchema,
} from "../../../src/lib/contracts/user-avatar.js";
import { GetAvatar, SetAvatar } from "../../../src/lib/contracts/ws-rpc.js";
import {
	defaultDaemonConfig,
	loadDaemonConfigResult,
	saveDaemonConfig,
} from "../../../src/lib/daemon/config-persistence.js";
import {
	AccountPictureLive,
	AccountPictureNone,
} from "../../../src/lib/domain/daemon/Layers/account-picture-layer.js";
import {
	ConfigPersistenceLive,
	ConfigSnapshotFromEffectStateLive,
	makeConfigWriterLive,
} from "../../../src/lib/domain/daemon/Layers/config-persistence-layer.js";
import { makeSubprocessLive } from "../../../src/lib/domain/daemon/Layers/subprocess-layer.js";
import { UserAvatarLive } from "../../../src/lib/domain/daemon/Layers/user-avatar-layer.js";
import { AccountPicture } from "../../../src/lib/domain/daemon/Services/account-picture.js";
import { ConfigPersistenceTag } from "../../../src/lib/domain/daemon/Services/config-persistence-service.js";
import {
	commitDaemonRuntimeConfig,
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { makeInstanceManagerStateLive } from "../../../src/lib/domain/daemon/Services/instance-manager-service.js";
import { makeProjectRegistryLive } from "../../../src/lib/domain/daemon/Services/project-registry-service.js";
import { Subprocess } from "../../../src/lib/domain/daemon/Services/subprocess.js";
import { UserAvatar } from "../../../src/lib/domain/daemon/Services/user-avatar.js";
import { sdkDefaultClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { settingsHandlers } from "../../../src/lib/server/ws-rpc/settings.js";

describe("user avatar", () => {
	it.effect(
		"resolves global identity, persists a seed across reload and preserves it on another save",
		() =>
			Effect.gen(function* () {
				const directory = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync("/tmp/conduit-avatar-")),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const gitConfig = join(directory, "gitconfig");
				const previousGlobal = process.env["GIT_CONFIG_GLOBAL"];
				process.env["GIT_CONFIG_GLOBAL"] = gitConfig;
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						if (previousGlobal === undefined)
							delete process.env["GIT_CONFIG_GLOBAL"];
						else process.env["GIT_CONFIG_GLOBAL"] = previousGlobal;
					}),
				);
				writeFileSync(gitConfig, "[user]\nname = Élodie Example\n");
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(defaultDaemonConfig(), directory),
				);
				const saved = Either.getOrThrowWith(
					loadDaemonConfigResult(directory),
					(error) => error,
				);
				expect(saved.avatar).toBeUndefined();
				const { pinHash: savedPinHash, ...savedSettings } = saved;
				const state = Layer.mergeAll(
					DaemonConfigRefLive(
						makeDaemonConfigFromOptions({
							...savedSettings,
							...(savedPinHash !== null && { pinHash: savedPinHash }),
						}),
					),
					makeProjectRegistryLive(),
					makeInstanceManagerStateLive(undefined, [], {
						launchLogin: sdkDefaultClaudeConfigDir(
							"/isolated-test-home/.claude",
						),
					}),
					makeConfigWriterLive(directory),
					AccountPictureNone,
					makeSubprocessLive(),
				);
				const dependencies = ConfigPersistenceLive.pipe(
					Layer.provideMerge(
						ConfigSnapshotFromEffectStateLive.pipe(Layer.provideMerge(state)),
					),
				);
				const context = yield* Layer.build(
					UserAvatarLive.pipe(Layer.provideMerge(dependencies)),
				);
				const responses: Avatar[] = [];
				const avatar = Context.get(context, UserAvatar);
				const subprocess = Context.get(context, Subprocess);
				const concurrent = yield* Effect.all(
					Array.from({ length: 8 }, () =>
						settingsHandlers.GetAvatar(GetAvatar.payloadSchema.make({})),
					),
					{ concurrency: 8 },
				).pipe(Effect.provide(context));
				const first = yield* avatar.get;
				responses.push(first);
				expect(first).toEqual({
					name: "Élodie Example",
					choice: null,
					macPicture: null,
				});
				for (const result of concurrent) expect(result).toEqual(first);
				for (let i = 0; i < 3; i++) expect(yield* avatar.get).toEqual(first);
				expect((yield* subprocess.metrics).spawnCount).toBe(1);
				responses.push(
					yield* settingsHandlers
						.SetAvatar(
							SetAvatar.payloadSchema.make({
								choice: { kind: "shape", seed: -2147483648 },
							}),
						)
						.pipe(Effect.provide(context)),
				);
				expect((yield* subprocess.metrics).spawnCount).toBe(2);
				writeFileSync(gitConfig, "");
				expect((yield* avatar.get).name).toBe("Élodie Example");
				expect((yield* subprocess.metrics).spawnCount).toBe(2);
				yield* commitDaemonRuntimeConfig((config) => ({
					...config,
					keepAwake: true,
				})).pipe(Effect.provide(context));
				const refreshed = yield* Effect.all(
					Array.from({ length: 8 }, () => avatar.get),
					{ concurrency: 8 },
				);
				for (const fallback of refreshed) {
					responses.push(fallback);
					expect(fallback.name).toBe(userInfo().username);
				}
				expect((yield* subprocess.metrics).spawnCount).toBe(3);
				writeFileSync(gitConfig, "[user]\nname = Updated Example\n");
				expect((yield* avatar.get).name).toBe(userInfo().username);
				expect((yield* subprocess.metrics).spawnCount).toBe(3);
				expect(
					(yield* avatar.set({ kind: "shape", seed: -2147483648 })).name,
				).toBe("Updated Example");
				expect((yield* subprocess.metrics).spawnCount).toBe(4);
				writeFileSync(gitConfig, "[user]\nname = TTL Example\n");
				yield* TestClock.adjust("10 minutes");
				expect((yield* avatar.get).name).toBe("TTL Example");
				expect((yield* subprocess.metrics).spawnCount).toBe(5);
				const persistence = Context.get(context, ConfigPersistenceTag);
				yield* persistence.requestSave;
				yield* persistence.flush;
				const reloaded = Either.getOrThrowWith(
					loadDaemonConfigResult(directory),
					(error) => error,
				);
				expect(reloaded.avatar).toEqual({ kind: "shape", seed: -2147483648 });
				expect(
					readFileSync(join(directory, "daemon.json"), "utf8"),
				).not.toContain("macPicture");
				const { pinHash: reloadedPinHash, ...reloadedSettings } = reloaded;
				const restarted = yield* Layer.build(
					UserAvatarLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								DaemonConfigRefLive(
									makeDaemonConfigFromOptions({
										...reloadedSettings,
										...(reloadedPinHash !== null && {
											pinHash: reloadedPinHash,
										}),
									}),
								),
								Layer.succeed(ConfigPersistenceTag, {
									requestSave: Effect.void,
									flush: Effect.void,
								}),
								AccountPictureNone,
							),
						),
					),
				);
				responses.push(yield* Context.get(restarted, UserAvatar).get);
				expect(responses.at(-1)?.choice).toEqual({
					kind: "shape",
					seed: -2147483648,
				});
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/user-avatar-service.json",
					JSON.stringify(responses, null, 2),
				);
			}),
	);

	it.effect(
		"reads changed pictures each time, keeps an unavailable Mac choice and omits an unreadable picture",
		() =>
			Effect.gen(function* () {
				let picture: Effect.Effect<
					Option.Option<Uint8Array>,
					Error
				> = Effect.succeed(Option.some(new Uint8Array([255, 216, 255, 217])));
				const context = yield* Layer.build(
					UserAvatarLive.pipe(
						Layer.provide(
							Layer.mergeAll(
								DaemonConfigRefLive(
									makeDaemonConfigFromOptions({ avatar: { kind: "mac" } }),
								),
								Layer.succeed(ConfigPersistenceTag, {
									requestSave: Effect.void,
									flush: Effect.void,
								}),
								Layer.succeed(AccountPicture, {
									read: Effect.suspend(() => picture),
								}),
							),
						),
					),
				);
				const avatar = Context.get(context, UserAvatar);
				expect((yield* avatar.get).macPicture).toBe(
					"data:image/jpeg;base64,/9j/2Q==",
				);
				picture = Effect.succeed(Option.none());
				expect(yield* avatar.get).toMatchObject({
					choice: { kind: "mac" },
					macPicture: null,
				});
				picture = Effect.fail(new Error("dscl timed out"));
				const unreadable = yield* avatar.get;
				expect(unreadable.choice).toEqual({ kind: "mac" });
				expect(unreadable).not.toHaveProperty("macPicture");
			}),
	);

	it.effect("reports persistence failures through the RPC", () =>
		Effect.gen(function* () {
			const context = yield* Layer.build(
				UserAvatarLive.pipe(
					Layer.provide(
						Layer.mergeAll(
							DaemonConfigRefLive(makeDaemonConfigFromOptions({})),
							Layer.succeed(ConfigPersistenceTag, {
								requestSave: Effect.void,
								flush: Effect.fail(new Error("disk full")),
							}),
							AccountPictureNone,
						),
					),
				),
			);
			const result = yield* Effect.result(
				settingsHandlers
					.SetAvatar(
						SetAvatar.payloadSchema.make({ choice: { kind: "initial" } }),
					)
					.pipe(Effect.provide(context)),
			);
			expect(Either.isFailure(result) && result.failure.message).toContain(
				"disk full",
			);
		}),
	);

	it("rejects unknown presets and seeds outside int32 before writing", () => {
		for (const choice of [
			{ kind: "preset", id: "unknown" },
			{ kind: "shape", seed: 1.5 },
			{ kind: "shape", seed: 2147483648 },
			{ kind: "shape", seed: -2147483649 },
		])
			expect(
				Either.isFailure(
					Schema.decodeUnknownResult(AvatarChoiceSchema)(choice),
				),
			).toBe(true);
		expect(
			Schema.decodeUnknownSync(AvatarChoiceSchema)({
				kind: "preset",
				id: "orb-pink",
			}),
		).toEqual({ kind: "preset", id: "orb-pink" });
	});

	it.effect("the platform adapter returns a cached, bounded JPEG or none", () =>
		Effect.gen(function* () {
			const [picture, again] = yield* AccountPicture.pipe(
				Effect.flatMap((service) =>
					Effect.all([service.read, service.read], { concurrency: 2 }),
				),
				Effect.provide(AccountPictureLive),
			);
			expect(again).toBe(picture);
			if (process.platform !== "darwin")
				expect(Option.isNone(picture)).toBe(true);
			if (Option.isSome(picture)) {
				expect([...picture.value.slice(0, 2)]).toEqual([255, 216]);
				expect(picture.value.length).toBeLessThanOrEqual(128 * 1024);
				const directory = yield* Effect.acquireRelease(
					Effect.sync(() => mkdtempSync("/tmp/conduit-avatar-size-")),
					(directory) =>
						Effect.sync(() =>
							rmSync(directory, { recursive: true, force: true }),
						),
				);
				const image = join(directory, "avatar.jpg");
				writeFileSync(image, picture.value);
				const dimensions = execFileSync(
					"/usr/bin/sips",
					["-g", "pixelWidth", "-g", "pixelHeight", image],
					{ encoding: "utf8", timeout: 2000 },
				);
				for (const key of ["pixelWidth", "pixelHeight"]) {
					const value = Number(
						dimensions.match(new RegExp(`${key}: (\\d+)`))?.[1],
					);
					expect(value).toBeGreaterThan(0);
					expect(value).toBeLessThanOrEqual(160);
				}
			}
		}),
	);
});
