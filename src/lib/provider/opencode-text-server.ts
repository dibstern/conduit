import { mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { OpenCodeAccount } from "../contracts/account.js";
import {
	availableOpenCodePort,
	commitManagedOpenCodeSpawn,
	managedOpenCodeEnv,
	openCodeAuth,
	probeOpenCodeHealth,
	spawnManagedOpenCode,
	stopManagedOpenCode,
} from "../instance/managed-opencode-process.js";
import { OpenCodeAPI } from "../instance/opencode-api.js";
import { createSdkClient } from "../instance/sdk-factory.js";

/** A title call owns its server and scratch tree, including during startup. */
export const openCodeTextServerEffect = (
	account: OpenCodeAccount,
	config: Record<string, unknown>,
) =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.try(() => mkdtempSync(join(tmpdir(), "conduit-title-"))),
			(root) =>
				Effect.tryPromise(() =>
					rm(root, { recursive: true, force: true }),
				).pipe(Effect.orDie),
		);
		const cwd = join(root, "work");
		const env = yield* Effect.try(() => {
			const inherited = {
				...process.env,
				...(account.managed ? account.env : undefined),
			};
			// Never copy auth: an OAuth refresh must update shared credentials.
			const data =
				inherited["XDG_DATA_HOME"] ||
				join(inherited["HOME"] || homedir(), ".local", "share");
			for (const key of [
				"OPENCODE_CONFIG",
				"OPENCODE_CONFIG_DIR",
				"OPENCODE_CONFIG_CONTENT",
				"OPENCODE_AUTH_CONTENT",
				"OPENCODE_PERMISSION",
				"CONDUIT_OPENCODE_WORKTREE_PLUGIN",
			])
				delete inherited[key];
			for (const dir of ["work", "config", "home", "managed"])
				mkdirSync(join(root, dir), { mode: 0o700 });
			return managedOpenCodeEnv({
				...Object.fromEntries(
					Object.entries(inherited).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				),
				XDG_CONFIG_HOME: join(root, "config"),
				XDG_DATA_HOME: data,
				// Verified in the installed 1.18.34 binary. TEST_HOME also isolates
				// ~/.opencode, which DISABLE_PROJECT_CONFIG does not exclude.
				OPENCODE_TEST_HOME: join(root, "home"),
				OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
				OPENCODE_DISABLE_PROJECT_CONFIG: "1",
				OPENCODE_DISABLE_CLAUDE_CODE: "1",
				OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
				OPENCODE_PURE: "1",
				// Pure disables external plugins. Built-in OAuth adapters must remain.
				OPENCODE_DISABLE_DEFAULT_PLUGINS: "0",
				OPENCODE_DISABLE_AUTOUPDATE: "1",
				OPENCODE_AUTO_SHARE: "0",
				OPENCODE_CONFIG_CONTENT: JSON.stringify(
					Object.fromEntries(
						["provider", "enabled_providers", "disabled_providers"]
							.filter((key) => config[key] !== undefined)
							.map((key) => [key, config[key]]),
					),
				),
			});
		});
		const port = yield* Effect.tryPromise(() => availableOpenCodePort());
		const owned = yield* Effect.acquireRelease(
			Effect.tryPromise(() =>
				spawnManagedOpenCode("title", port, env, root, {
					cwd,
					inheritEnv: false,
				}),
			),
			(owned) =>
				Effect.tryPromise(async () => {
					if (await stopManagedOpenCode(owned)) return;
					if (
						owned.process.exitCode !== null ||
						owned.process.signalCode !== null
					)
						return;
					// The live child handle still owns this supervisor. Its SIGINT
					// handler stops its private group if the control socket is lost.
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(
							() =>
								reject(
									new Error("Could not stop isolated OpenCode supervisor"),
								),
							4000,
						);
						owned.process.once("exit", () => {
							clearTimeout(timer);
							resolve();
						});
						owned.process.kill("SIGINT");
					});
				}).pipe(Effect.orDie),
		);
		yield* Effect.tryPromise(() => commitManagedOpenCodeSpawn(owned.process));
		const deadline = Date.now() + 20_000;
		for (;;) {
			if (owned.process.exitCode !== null || owned.process.signalCode !== null)
				return yield* Effect.fail(
					new Error("Isolated OpenCode exited during startup"),
				);
			if (yield* Effect.tryPromise(() => probeOpenCodeHealth(port, env))) break;
			if (Date.now() >= deadline)
				return yield* Effect.fail(
					new Error("Timed out waiting for isolated OpenCode health"),
				);
			yield* Effect.sleep("100 millis");
		}
		const baseUrl = `http://127.0.0.1:${port}`;
		const auth = openCodeAuth(env);
		const sdk = createSdkClient({
			baseUrl,
			directory: cwd,
			...(auth ? { auth } : {}),
			retry: { retries: 0 },
		});
		return {
			client: new OpenCodeAPI({
				sdk: sdk.client,
				baseUrl,
				authHeaders: sdk.authHeaders,
			}),
			cwd,
			root,
			process: owned.process,
			pid: owned.pid,
		};
	});
