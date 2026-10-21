// Failure modes: shared credentials/catalogues, removed-account fallback, early
// idle cleanup, failed opens cached forever, and cancellation crossing accounts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { afterEach, expect, it } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import { AccountIdSchema } from "../../../src/lib/contracts/account.js";
import { CLAUDE_DISPLAYABLE_SETTINGS_KEYS } from "../../../src/lib/contracts/claude-settings.js";
import { makeAccountResourceScopesLive } from "../../../src/lib/domain/daemon/Layers/account-resource-scopes-layer.js";
import {
	AccountDirectory,
	AccountDirectoryStateLive,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { AccountResourceScopesTag } from "../../../src/lib/domain/daemon/Services/account-resource-scopes.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { resolveClaudeSettingsForInstance } from "../../../src/lib/handlers/claude-settings.js";
import {
	ClaudeAccountScopes,
	makeClaudeAccountScopes,
} from "../../../src/lib/provider/claude/claude-account-scopes.js";
import { makeClaudeCapabilitiesService } from "../../../src/lib/provider/claude/claude-capabilities-service.js";
import {
	makeClaudeProviderRuntime,
	makeClaudeSessionRunner,
} from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { ClaudeBoundaryError } from "../../../src/lib/provider/event-sink-errors.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

const roots: string[] = [];
const evidence: { name: string; result: string | undefined }[] = [];
afterEach(({ task }) => {
	evidence.push({ name: task.name, result: task.result?.state });
	writeFileSync(
		"/tmp/82tn9-4-claude-account-scopes.json",
		JSON.stringify(evidence, null, 2),
	);
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

it("two Claude accounts sharing a folder probe and resolve settings with their own env", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-claude-account-env-"));
	roots.push(root);
	const state = accountsStateFromInstances(
		["a", "b"].map((id) => ({
			id,
			name: id,
			driver: "claude" as const,
			configDir: root,
			env: { ACCOUNT: id },
		})),
		{ _tag: "Configured", path: root },
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			const probes: string[] = [];
			const scopes = yield* makeClaudeAccountScopes({
				accounts: directory.snapshot,
				openCapabilities: () =>
					makeClaudeCapabilitiesService({
						launchConfig: () => ({
							configDir: { _tag: "Configured", path: root },
							folderSource: "account",
						}),
						queryFactory: ({ options }) => {
							const id = options?.env?.["ACCOUNT"] ?? "missing";
							probes.push(id);
							return {
								initializationResult: async () => ({
									models: [{ value: `model-${id}`, displayName: id }],
								}),
								async *[Symbol.asyncIterator]() {
									yield { type: "system", subtype: "init" };
								},
							};
						},
					}),
			});
			const instance = yield* makeClaudeProviderRuntime({
				workspaceRoot: root,
				daemonConfigDir: root,
				runnerFactory: makeClaudeSessionRunner,
			}).pipe(Effect.provideService(ClaudeAccountScopes, scopes));
			for (const account of state.accounts) {
				const call = {
					projectId: "p",
					sessionId: "",
					account,
					workspaceRoot: root,
					extraFolders: [],
					shellEnv: { HOME: root },
				};
				const caps = yield* instance.discoverEffect(
					root,
					account,
					undefined,
					call,
				);
				expect(caps.models[0]?.id).toBe(`model-${account.id}`);
				const settings = yield* resolveClaudeSettingsForInstance(
					{ instanceId: account.id },
					async ({ env }) => ({
						stdout: JSON.stringify({
							...Object.fromEntries(
								CLAUDE_DISPLAYABLE_SETTINGS_KEYS.map((key) => [key, {}]),
							),
							attribution: {
								value: env["ACCOUNT"] ?? "missing",
								source: "user",
							},
						}),
						stderr: "",
						exitCode: 0,
						timedOut: false,
						outputTooLarge: false,
					}),
				).pipe(
					Effect.provideService(ClaudeAccountScopes, scopes),
					Effect.provideService(
						ConfigTag,
						makeMockConfig({ projectDir: root, configDir: root }),
					),
				);
				expect(settings.attribution.value).toBe(account.id);
			}
			expect(probes).toEqual(["a", "b"]);
		}).pipe(
			Effect.scoped,
			Effect.provideService(SessionWorkspaceTag, {
				get: () => Effect.succeed(root),
				renameBranch: () => Effect.die("unused"),
				move: () => Effect.die("unused"),
				inherit: () => Effect.die("unused"),
				resolve: () => Effect.die("unused"),
				preview: () => Effect.die("unused"),
				record: () => Effect.die("unused"),
				claudeWorktreeState: () => Effect.die("unused"),
				withLaunch: (effect) => effect,
			}),
			Effect.provide(
				Layer.mergeAll(
					makeAccountResourceScopesLive({ idleTimeoutMs: 20 }),
					AccountDirectoryStateLive(state),
				),
			),
		),
	);
});

it("invalidating Claude A cancels its title query while B on the same folder keeps running", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-claude-account-scopes-"));
	roots.push(root);
	const folder = join(root, "login");
	mkdirSync(folder);
	const state = accountsStateFromInstances(
		["a", "b"].map((id) => ({
			id,
			name: id,
			driver: "claude" as const,
			configDir: folder,
			env: { ACCOUNT: id },
		})),
		{ _tag: "Configured", path: folder },
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const scopes = yield* AccountResourceScopesTag;
			const startedA = yield* Deferred.make<void>();
			const startedB = yield* Deferred.make<void>();
			const releases = new Map<string, () => void>();
			const aborted: string[] = [];
			const instance = yield* makeClaudeProviderRuntime({
				workspaceRoot: root,
				daemonConfigDir: root,
				runnerFactory: makeClaudeSessionRunner,
				generateTextQueryFactory: ({ options }) => ({
					async *[Symbol.asyncIterator]() {
						const id = options?.env?.["ACCOUNT"] ?? "missing";
						await new Promise<void>((done) => {
							releases.set(id, done);
							options?.abortController?.signal.addEventListener(
								"abort",
								() => {
									aborted.push(id);
									done();
								},
								{ once: true },
							);
							Effect.runSync(
								Deferred.succeed(id === "a" ? startedA : startedB, undefined),
							);
						});
						yield { type: "result", result: id };
					},
				}),
			});
			const start = (id: string) => {
				const account = state.accounts.find((account) => account.id === id);
				if (!account) throw new Error("Missing fixture account");
				return instance
					.generateTextEffect({
						account,
						model: { providerId: "claude", modelId: "sonnet" },
						instructions: "Title",
						prompt: "Hello",
						effort: "",
					})
					.pipe(Effect.forkChild);
			};
			const a = yield* start("a");
			const b = yield* start("b");
			yield* Deferred.await(startedA);
			yield* Deferred.await(startedB);
			yield* scopes.invalidate(AccountIdSchema.make("a"));
			yield* Effect.yieldNow;
			const aExit = a.pollUnsafe();
			expect(aExit !== undefined && Exit.isFailure(aExit)).toBe(true);
			expect(aborted).toContain("a");
			expect(b.pollUnsafe()).toBeUndefined();
			releases.get("b")?.();
			expect(yield* Fiber.join(b)).toBe("b");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.mergeAll(
					makeAccountResourceScopesLive({ idleTimeoutMs: 20 }),
					AccountDirectoryStateLive(state),
				),
			),
		),
	);
});

it("Claude discovery shares first open, retries a failed open, then closes and reopens at idle", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-claude-scope-retry-"));
	roots.push(root);
	const state = accountsStateFromInstances(
		[
			{
				id: "a",
				name: "A",
				driver: "claude",
				configDir: root,
				env: { ACCOUNT: "a" },
			},
		],
		{ _tag: "Configured", path: root },
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			let opens = 0;
			let closes = 0;
			let probes = 0;
			const scopes = yield* makeClaudeAccountScopes({
				accounts: directory.snapshot,
				openCapabilities: () =>
					Effect.gen(function* () {
						const generation = ++opens;
						yield* Effect.addFinalizer(() =>
							Effect.sync(() => {
								closes++;
							}),
						);
						if (generation === 1)
							return yield* new ClaudeBoundaryError({
								operation: "openCapabilities",
								cause: new Error("first open fails"),
							});
						return yield* makeClaudeCapabilitiesService({
							launchConfig: () => {
								throw new Error("admitted call required");
							},
							queryFactory: ({ options }) => {
								probes++;
								return {
									initializationResult: async () => {
										await new Promise<void>((done) => setTimeout(done, 60));
										return {
											models: [
												{
													value: `generation-${generation}`,
													displayName: options?.env?.["ACCOUNT"] ?? "missing",
												},
											],
										};
									},
									async *[Symbol.asyncIterator]() {
										yield { type: "system", subtype: "init" };
									},
								};
							},
						});
					}),
			});
			const instance = yield* makeClaudeProviderRuntime({
				workspaceRoot: root,
				daemonConfigDir: root,
				runnerFactory: makeClaudeSessionRunner,
			}).pipe(Effect.provideService(ClaudeAccountScopes, scopes));
			const account = state.accounts[0];
			if (!account) throw new Error("Missing fixture account");
			const discover = () =>
				instance.discoverEffect(root, account, undefined, {
					projectId: "p",
					sessionId: "",
					account,
					workspaceRoot: root,
					extraFolders: [],
					shellEnv: { HOME: root },
				});
			expect((yield* Effect.result(discover()))._tag).toBe("Failure");
			const results = yield* Effect.all([discover(), discover()], {
				concurrency: 2,
			});
			expect(results.map((caps) => caps.models[0]?.id)).toEqual([
				"generation-2",
				"generation-2",
			]);
			expect({ opens, closes, probes }).toEqual({
				opens: 2,
				closes: 1,
				probes: 1,
			});
			yield* Effect.sleep(80);
			expect(closes).toBe(2);
			expect((yield* discover()).models[0]?.id).toBe("generation-3");
			expect({ opens, probes }).toEqual({ opens: 3, probes: 2 });
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.mergeAll(
					makeAccountResourceScopesLive({ idleTimeoutMs: 20 }),
					AccountDirectoryStateLive(state),
				),
			),
		),
	);
});

it("removal during Claude scope open fences a late finalizer before the next generation", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-claude-scope-open-"));
	roots.push(root);
	const state = accountsStateFromInstances(
		[{ id: "a", name: "A", driver: "claude", configDir: root }],
		{ _tag: "Configured", path: root },
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			const owner = yield* AccountResourceScopesTag;
			const opening = yield* Deferred.make<void>();
			const finalizing = yield* Deferred.make<void>();
			const finish = yield* Deferred.make<void>();
			let opens = 0;
			let live = 0;
			const scopes = yield* makeClaudeAccountScopes({
				accounts: directory.snapshot,
				openCapabilities: () =>
					Effect.gen(function* () {
						const generation = ++opens;
						live++;
						yield* Effect.addFinalizer(() =>
							Effect.gen(function* () {
								if (generation === 1) {
									yield* Deferred.succeed(finalizing, undefined);
									yield* Deferred.await(finish);
								}
								live--;
							}),
						);
						if (generation === 1) {
							yield* Deferred.succeed(opening, undefined);
							yield* Effect.never;
						}
						return {
							get: () =>
								Effect.succeed({
									models: [
										{
											id: `generation-${generation}`,
											name: "A",
											providerId: "claude",
										},
									],
									commands: [],
									agents: [],
								}),
						};
					}),
			});
			const instance = yield* makeClaudeProviderRuntime({
				workspaceRoot: root,
				daemonConfigDir: root,
				runnerFactory: makeClaudeSessionRunner,
			}).pipe(Effect.provideService(ClaudeAccountScopes, scopes));
			const account = state.accounts[0];
			if (!account) throw new Error("Missing fixture account");
			const first = yield* instance
				.discoverEffect(root, account)
				.pipe(Effect.forkChild);
			yield* Deferred.await(opening);
			const removal = yield* owner.invalidate("a").pipe(Effect.forkChild);
			yield* Deferred.await(finalizing);
			const next = yield* instance
				.discoverEffect(root, account)
				.pipe(Effect.forkChild);
			yield* Effect.yieldNow;
			expect({ opens, live }).toEqual({ opens: 1, live: 1 });
			yield* Deferred.succeed(finish, undefined);
			yield* Fiber.join(removal);
			expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
			expect((yield* Fiber.join(next)).models[0]?.id).toBe("generation-2");
			expect({ opens, live }).toEqual({ opens: 2, live: 1 });
			yield* Effect.sleep(80);
			expect(live).toBe(0);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.mergeAll(
					makeAccountResourceScopesLive({ idleTimeoutMs: 20 }),
					AccountDirectoryStateLive(state),
				),
			),
		),
	);
});

it("a removed admission keeps its identity without borrowing the default account env", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-claude-scope-removed-"));
	roots.push(root);
	const state = accountsStateFromInstances(
		["a", "b"].map((id) => ({
			id,
			name: id,
			driver: "claude" as const,
			configDir: root,
			env: { ACCOUNT: id },
		})),
		{ _tag: "Configured", path: root },
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			const instance = yield* makeClaudeProviderRuntime({
				workspaceRoot: root,
				daemonConfigDir: root,
				runnerFactory: makeClaudeSessionRunner,
				generateTextQueryFactory: ({ options }) => ({
					async *[Symbol.asyncIterator]() {
						yield {
							type: "result",
							result: options?.env?.["ACCOUNT"] ?? "no-account-env",
						};
					},
				}),
			});
			const account = state.accounts[0];
			if (!account) throw new Error("Missing fixture account");
			const input = {
				account,
				model: { providerId: "claude", modelId: "sonnet" },
				instructions: "Title",
				prompt: "Hello",
				effort: "",
			};
			expect(yield* instance.generateTextEffect(input)).toBe("a");
			yield* directory.apply({ _tag: "Remove", id: account.id });
			yield* (yield* AccountResourceScopesTag).invalidate(account.id);
			expect(yield* instance.generateTextEffect(input)).toBe("no-account-env");
			const settings = yield* Effect.result(
				resolveClaudeSettingsForInstance(
					{ instanceId: account.id },
					async () => ({
						stdout: JSON.stringify(
							Object.fromEntries(
								CLAUDE_DISPLAYABLE_SETTINGS_KEYS.map((key) => [key, {}]),
							),
						),
						stderr: "",
						exitCode: 0,
						timedOut: false,
						outputTooLarge: false,
					}),
				),
			);
			expect(settings._tag).toBe("Failure");
		}).pipe(
			Effect.scoped,
			Effect.provideService(SessionWorkspaceTag, {
				get: () => Effect.succeed(root),
				renameBranch: () => Effect.die("unused"),
				move: () => Effect.die("unused"),
				inherit: () => Effect.die("unused"),
				resolve: () => Effect.die("unused"),
				preview: () => Effect.die("unused"),
				record: () => Effect.die("unused"),
				claudeWorktreeState: () => Effect.die("unused"),
				withLaunch: (effect) => effect,
			}),
			Effect.provideService(
				ConfigTag,
				makeMockConfig({ projectDir: root, configDir: root }),
			),
			Effect.provide(
				Layer.mergeAll(
					makeAccountResourceScopesLive({ idleTimeoutMs: 20 }),
					AccountDirectoryStateLive(state),
				),
			),
		),
	);
});

it("removing a Claude scope aborts its actual in-flight SDK capability probe", async () => {
	const root = mkdtempSync(join(tmpdir(), "conduit-claude-scope-probe-"));
	roots.push(root);
	const state = accountsStateFromInstances(
		[{ id: "a", name: "A", driver: "claude", configDir: root }],
		{ _tag: "Configured", path: root },
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const directory = yield* AccountDirectory;
			const started = yield* Deferred.make<void>();
			let aborted = false;
			const scopes = yield* makeClaudeAccountScopes({
				accounts: directory.snapshot,
				openCapabilities: () =>
					makeClaudeCapabilitiesService({
						launchConfig: () => {
							throw new Error("admitted call required");
						},
						queryFactory: ({ options }) => ({
							initializationResult: () =>
								new Promise((done) => {
									options?.abortController?.signal.addEventListener(
										"abort",
										() => {
											aborted = true;
											done({ models: [] });
										},
										{ once: true },
									);
									Effect.runSync(Deferred.succeed(started, undefined));
								}),
							async *[Symbol.asyncIterator]() {
								yield { type: "system", subtype: "init" };
							},
						}),
					}),
			});
			const instance = yield* makeClaudeProviderRuntime({
				workspaceRoot: root,
				daemonConfigDir: root,
				runnerFactory: makeClaudeSessionRunner,
			}).pipe(Effect.provideService(ClaudeAccountScopes, scopes));
			const account = state.accounts[0];
			if (!account) throw new Error("Missing fixture account");
			const probe = yield* instance
				.discoverEffect(root, account)
				.pipe(Effect.forkChild);
			yield* Deferred.await(started);
			yield* (yield* AccountResourceScopesTag).invalidate(account.id);
			expect(aborted).toBe(true);
			expect(Exit.isFailure(yield* Fiber.await(probe))).toBe(true);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Layer.mergeAll(
					makeAccountResourceScopesLive({ idleTimeoutMs: 20 }),
					AccountDirectoryStateLive(state),
				),
			),
		),
	);
});
