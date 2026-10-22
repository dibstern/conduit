import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect, Result, Schema, Semaphore } from "effect";
import type { Account } from "../../contracts/account.js";
import { createLogger } from "../../logger.js";
import { ProviderInstanceFailure } from "../errors.js";
import type { CommandInfo, ModelInfo, ProviderCapabilities } from "../types.js";
import { openAppServerTransport } from "./app-server/app-server.js";
import {
	CodexVersionUnsupported,
	connectAppServer,
} from "./app-server/client.js";
import {
	AccountReadResponseSchema,
	ModelListResponseSchema,
	type ModelSchema,
	SkillMetadataSchema,
	SkillsListResponseSchema,
} from "./app-server/protocol.js";
import { AppServerIoError } from "./app-server/transport.js";
import { codexAccountHome, prepareCodexAccount } from "./codex-home.js";

const log = createLogger("codex-discovery");
const decodeSkill = Schema.decodeUnknownResult(SkillMetadataSchema);

export function codexModelInfo(model: typeof ModelSchema.Type): ModelInfo {
	const efforts = model.supportedReasoningEfforts;
	return {
		id: model.model,
		name: model.displayName,
		providerId: "codex",
		...(efforts.length
			? {
					variants: Object.fromEntries(
						efforts.map(({ reasoningEffort }) => [
							reasoningEffort,
							{
								params: [{ id: "effort", value: reasoningEffort }],
								...(reasoningEffort === model.defaultReasoningEffort
									? { isDefault: true }
									: {}),
							},
						]),
					),
					parameters: {
						rows: [
							{
								id: "effort",
								label: "Reasoning effort",
								values: efforts.map(({ reasoningEffort }) => ({
									value: reasoningEffort,
									label: reasoningEffort,
								})),
							},
						],
						combinations: efforts.map(({ reasoningEffort }) => ({
							variant: reasoningEffort,
							values: { effort: reasoningEffort },
							...(reasoningEffort === model.defaultReasoningEffort
								? { isDefault: true }
								: {}),
						})),
					},
				}
			: {}),
	};
}

export interface DiscoveredCodexAccount {
	readonly signedIn: boolean;
	readonly models: readonly ModelInfo[];
	readonly skills: readonly (typeof SkillMetadataSchema.Type)[];
}

const catalogs = new Map<
	string,
	{
		readonly expiresAt: number;
		readonly catalog: Omit<DiscoveredCodexAccount, "signedIn">;
	}
>();
const failures = new Map<
	string,
	{ readonly expiresAt: number; readonly failure: ProviderInstanceFailure }
>();
const authentication = new Map<
	string,
	{ readonly fingerprint: string; readonly signedIn: boolean }
>();
const authVersions = new Map<string, number>();
export function invalidateCodexAuth(home: string): void {
	authentication.delete(home);
	authVersions.set(home, (authVersions.get(home) ?? 0) + 1);
}

function authFingerprint(home: string): string {
	// Only metadata is inspected. Credential contents belong to the CLI.
	const stat = statSync(join(home, "auth.json"), { throwIfNoEntry: false });
	return `${stat?.ino}:${stat?.mtimeMs}:${stat?.ctimeMs}:${stat?.size}`;
}
const discoveryLock = Semaphore.makeUnsafe(1);

/** Both discovery and usage probes borrow the account's login in a scoped child. */
export const openCodexDiscoveryClient = (
	home?: string,
	accountEnv?: NodeJS.ProcessEnv,
	scenario = "codex-discovery",
	replaceEnvironment = false,
) =>
	Effect.gen(function* () {
		const env: NodeJS.ProcessEnv = {
			...(replaceEnvironment ? {} : process.env),
			...accountEnv,
		};
		env["CODEX_HOME"] = codexAccountHome(
			home === undefined ? undefined : { id: "codex", configuredFolder: home },
			undefined,
			env,
		);
		if (
			scenario === "codex-usage" &&
			env["NODE_ENV"] === "test" &&
			env["CONDUIT_TEST_CODEX_USAGE_TRACE"]
		)
			env["CONDUIT_CODEX_APP_SERVER_TRACE"] =
				env["CONDUIT_TEST_CODEX_USAGE_TRACE"];
		const transport = yield* openAppServerTransport({ env, scenario });
		return yield* connectAppServer(transport, {
			clientInfo: { name: "conduit", version: "1.0.0" },
		});
	});

/** Discovery owns a short-lived child; sessions own their separate live child. */
export const discoverCodex = (
	home?: string,
	accountEnv?: NodeJS.ProcessEnv,
	workspaceRoot?: string,
	replaceEnvironment = false,
	options?: { readonly refresh?: boolean },
): Effect.Effect<DiscoveredCodexAccount, ProviderInstanceFailure> =>
	discoveryLock.withPermits(1)(
		Effect.gen(function* () {
			const cwd = resolve(workspaceRoot ?? process.cwd());
			const codexHome = codexAccountHome(
				home === undefined
					? undefined
					: { id: "codex", configuredFolder: home },
				undefined,
				{ ...(replaceEnvironment ? {} : process.env), ...accountEnv },
			);
			const key = JSON.stringify([codexHome, cwd]);
			const remembered = failures.get(key);
			if (!options?.refresh && remembered && remembered.expiresAt > Date.now())
				return yield* Effect.fail(remembered.failure);
			return yield* Effect.gen(function* () {
				const fingerprint = yield* Effect.try(() =>
					authFingerprint(codexHome),
				).pipe(
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "codex",
								operation: "auth metadata",
								cause,
							}),
					),
				);
				const auth = authentication.get(codexHome);
				const cachedAuth = auth?.fingerprint === fingerprint ? auth : undefined;
				const cached = catalogs.get(key);
				const catalog =
					cached && cached.expiresAt > Date.now() ? cached.catalog : undefined;
				if (cachedAuth && catalog)
					return { ...catalog, signedIn: cachedAuth.signedIn };
				const version = authVersions.get(codexHome) ?? 0;
				const account = yield* Effect.scoped(
					Effect.gen(function* () {
						const client = yield* openCodexDiscoveryClient(
							codexHome,
							accountEnv,
							catalog ? "codex-discovery-auth" : "codex-discovery",
							replaceEnvironment,
						);
						const signedIn =
							cachedAuth?.signedIn ??
							(yield* client.request(
								"account/read",
								{},
								AccountReadResponseSchema,
							)).account != null;
						if (version === (authVersions.get(codexHome) ?? 0))
							authentication.set(codexHome, { fingerprint, signedIn });
						if (catalog) return { ...catalog, signedIn };
						const models: ModelInfo[] = [];
						let cursor: string | null = null;
						do {
							const page: typeof ModelListResponseSchema.Type =
								yield* client.request(
									"model/list",
									{ cursor, limit: 100, includeHidden: true },
									ModelListResponseSchema,
								);
							models.push(
								...page.data
									.filter((model) => !model.hidden)
									.map(codexModelInfo),
							);
							cursor = page.nextCursor;
						} while (cursor !== null);
						const listed = yield* client.request(
							"skills/list",
							{ cwds: [cwd] },
							SkillsListResponseSchema,
						);
						const skills: (typeof SkillMetadataSchema.Type)[] = [];
						for (const entry of listed.data) {
							for (const error of entry.errors)
								log.warn("codex.skill_discovery_failed", {
									cwd: entry.cwd,
									...error,
								});
							for (const descriptor of entry.skills) {
								const decoded = decodeSkill(descriptor);
								if (Result.isFailure(decoded)) {
									log.warn("codex.skill_decode_failed", { cwd: entry.cwd });
									continue;
								}
								const skill = decoded.success;
								if (!skill.enabled) {
									log.debug("codex.skill_disabled", {
										name: skill.name,
										path: skill.path,
									});
									continue;
								}
								skills.push(skill);
							}
						}
						catalogs.set(key, {
							expiresAt: Date.now() + 30 * 60_000,
							catalog: { models, skills },
						});
						return { signedIn, models, skills };
					}),
				).pipe(
					Effect.timeoutOrElse({
						duration: "15 seconds",
						orElse: () => Effect.fail(new Error("Codex discovery timed out")),
					}),
					Effect.mapError(
						(cause) =>
							new ProviderInstanceFailure({
								providerId: "codex",
								operation: "discover",
								...(cause instanceof CodexVersionUnsupported
									? { code: "codex_version_unsupported" as const }
									: {}),
								cause:
									cause instanceof CodexVersionUnsupported
										? new Error(
												`codex_version_unsupported: Codex ${cause.minimum} or newer is required (found ${cause.found})`,
											)
										: cause instanceof AppServerIoError &&
												cause.cause instanceof Error &&
												"code" in cause.cause &&
												cause.cause.code === "ENOENT"
											? new Error(
													"Codex CLI is unavailable. Install Codex and run codex login.",
												)
											: cause,
							}),
					),
				);
				return account;
			}).pipe(
				Effect.tapError((failure) =>
					Effect.sync(() => {
						failures.set(key, { expiresAt: Date.now() + 60_000, failure });
					}),
				),
				Effect.tap(() => Effect.sync(() => failures.delete(key))),
			);
		}),
	);

export const discoverCodexEffect = (
	account?: Account,
	workspaceRoot?: string,
	configDir?: string,
	options?: { readonly refresh?: boolean },
): Effect.Effect<ProviderCapabilities, ProviderInstanceFailure> =>
	prepareCodexAccount(account, configDir).pipe(
		Effect.flatMap(({ home, env }) =>
			discoverCodex(home, env, workspaceRoot, true, options),
		),
		Effect.flatMap((discovered) =>
			discovered.signedIn
				? Effect.succeed({
						models: discovered.models,
						supportsTools: true,
						supportsThinking: true,
						supportsPermissions: true,
						supportsQuestions: true,
						supportsAttachments: false,
						supportsFork: true,
						supportsRevert: false,
						commands: [
							{
								name: "compact",
								description: "Compact conversation context",
								source: "builtin",
							},
							...discovered.skills.map(
								(skill): CommandInfo => ({
									name: skill.name,
									description: skill.description,
									// System and admin skills are installed for the user, like user skills.
									source:
										skill.scope === "repo" ? "project-skill" : "user-skill",
								}),
							),
						] satisfies CommandInfo[],
					})
				: Effect.fail(
						new ProviderInstanceFailure({
							providerId: "codex",
							operation: "discover",
							cause: new Error(
								"Codex authentication required. Run codex login.",
							),
							code: "auth_required",
						}),
					),
		),
	);
