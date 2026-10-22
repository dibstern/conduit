import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { ProviderInstanceFailure } from "../errors.js";

const log = createLogger("codex-home");
interface CodexHomeAccount {
	readonly id: string;
	readonly configuredFolder?: string | undefined;
	readonly env?: Readonly<Record<string, string>> | undefined;
}
// Codex's built-in OpenAI authentication inputs. Strip after account overrides too.
export const CODEX_CREDENTIAL_ENV = [
	"OPENAI_API_KEY",
	"CODEX_API_KEY",
	"CODEX_ACCESS_TOKEN",
] as const;

function expandHome(folder: string): string {
	return resolve(
		folder === "~"
			? homedir()
			: folder.startsWith("~/")
				? join(homedir(), folder.slice(2))
				: folder,
	);
}

export function codexAccountHome(
	account?: CodexHomeAccount,
	configDir = DEFAULT_CONFIG_DIR,
	inheritedEnv: NodeJS.ProcessEnv = process.env,
): string {
	if (account?.configuredFolder) return expandHome(account.configuredFolder);
	// driver-dispatch-ok: The reserved account id selects the ambient home, not a capability.
	if (account && account.id !== "codex")
		return join(
			configDir,
			"codex",
			"accounts",
			encodeURIComponent(account.id).replaceAll(".", "%2E"),
		);
	return expandHome(
		account?.env?.["CODEX_HOME"] ||
			inheritedEnv["CODEX_HOME"] ||
			join(homedir(), ".codex"),
	);
}

/** Named homes share conduit's own rollouts and ambient user configuration, never CLI history, credentials or caches. */
export const prepareCodexAccount = (
	account?: CodexHomeAccount,
	configDir = DEFAULT_CONFIG_DIR,
	inheritedEnv: NodeJS.ProcessEnv = process.env,
) =>
	Effect.try({
		try: () => {
			const env: NodeJS.ProcessEnv = { ...inheritedEnv, ...account?.env };
			const home = codexAccountHome(account, configDir, inheritedEnv);
			const named =
				account !== undefined &&
				// driver-dispatch-ok: The reserved account id selects the ambient home, not a capability.
				(account.id !== "codex" || Boolean(account.configuredFolder));
			if (named) for (const key of CODEX_CREDENTIAL_ENV) delete env[key];
			env["CODEX_HOME"] = home;
			if (named && !account.configuredFolder) {
				const base = expandHome(
					inheritedEnv["CODEX_HOME"] || join(homedir(), ".codex"),
				);
				mkdirSync(home, { recursive: true, mode: 0o700 });
				const sessions = join(configDir, "codex", "sessions");
				mkdirSync(sessions, { recursive: true, mode: 0o700 });
				mkdirSync(join(base, "skills"), { recursive: true, mode: 0o700 });
				for (const name of ["sessions", "config.toml", "skills", "AGENTS.md"]) {
					const path = join(home, name);
					const target = name === "sessions" ? sessions : join(base, name);
					const existing = lstatSync(path, { throwIfNoEntry: false });
					if (existing && !existing.isSymbolicLink()) {
						log.warn("codex.shared_path_conflict", {
							accountId: account.id,
							path,
							target,
						});
						continue;
					}
					if (existing && resolve(dirname(path), readlinkSync(path)) === target)
						continue;
					if (existing) {
						// force: a concurrent prepare of the same account may relink first.
						rmSync(path, { force: true });
						if (name === "sessions") {
							const removedStateFiles: string[] = [];
							for (const entry of readdirSync(home, { withFileTypes: true })) {
								if (
									entry.isFile() &&
									/^state_.*\.sqlite(?:-wal|-shm)?$/.test(entry.name)
								) {
									rmSync(join(home, entry.name), { force: true });
									removedStateFiles.push(entry.name);
								}
							}
							log.info("codex.sessions_relinked", {
								accountId: account.id,
								path,
								target,
								removedStateFiles,
							});
						}
					}
					try {
						symlinkSync(
							target,
							path,
							name === "sessions" || name === "skills" ? "dir" : "file",
						);
					} catch (cause) {
						// Another discovery/runner may have created the same link.
						if (
							!(
								cause instanceof Error &&
								"code" in cause &&
								cause.code === "EEXIST"
							)
						)
							throw cause;
					}
				}
			}
			return { home, env };
		},
		catch: (cause) =>
			new ProviderInstanceFailure({
				providerId: account?.id ?? "codex",
				operation: "prepare home",
				cause,
			}),
	});
