import { randomUUID } from "node:crypto";
import {
	chmodSync,
	constants,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Redacted } from "effect";
import type { CursorCredentialEnvelope } from "./cursor-credential.js";
import { CursorSdkFailure, cursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorAgentOptions,
	CursorCustomTool,
	CursorSdkPort,
	CursorStore,
} from "./sdk-port.js";

/** Runs once at startup, before any account can log in or out. */
export async function adoptLegacyCursorCredential(
	storePath: string,
	markerPath: string,
	legacyStorePath?: string,
): Promise<string> {
	const completed = `${markerPath}.complete`;
	if (existsSync(completed)) return readFileSync(markerPath, "utf8");
	mkdirSync(dirname(markerPath), { recursive: true, mode: 0o700 });
	// Claim the original target before any work that can fail or be interrupted.
	// Publish the claim atomically so another startup can only read a full path.
	const claim = `${markerPath}.${randomUUID()}.tmp`;
	try {
		writeFileSync(claim, storePath, { mode: 0o600, flag: "wx" });
		try {
			linkSync(claim, markerPath);
		} catch (cause) {
			if (
				!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")
			)
				throw cause;
		}
	} finally {
		rmSync(claim, { force: true });
	}
	const selectedStorePath = readFileSync(markerPath, "utf8");
	const { FileCredentialStore } = await import("@cursor/sdk");
	const legacy = new FileCredentialStore(legacyStorePath);
	const scoped = new FileCredentialStore(selectedStorePath);
	if (!(await scoped.load()) && (await legacy.load())) {
		mkdirSync(dirname(selectedStorePath), { recursive: true, mode: 0o700 });
		chmodSync(dirname(selectedStorePath), 0o700);
		const temporary = `${selectedStorePath}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, readFileSync(legacy.path), {
				mode: 0o600,
				flag: "wx",
			});
			renameSync(temporary, selectedStorePath);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
	// Record even an empty/existing store, so logout, removal or a later
	// default change can never cause another account to inherit the old login.
	writeFileSync(completed, "", { mode: 0o600 });
	return selectedStorePath;
}

export function createRealCursorSdkPort(
	credentialStorePath?: string,
): CursorSdkPort {
	let sdk: Promise<typeof import("@cursor/sdk")> | undefined;
	let pendingLogin: Promise<void> | undefined;
	const load = () => (sdk ??= import("@cursor/sdk"));
	let credentials: import("@cursor/sdk").FileCredentialStore | undefined;
	const credentialStore = async () =>
		(credentials ??= new (await load()).FileCredentialStore(
			credentialStorePath,
		));
	const call = async <A>(
		operation: string,
		run: () => Promise<A>,
	): Promise<A> => {
		try {
			return await run();
		} catch (cause) {
			throw cursorSdkFailure(operation, cause);
		}
	};
	const stores = new WeakMap<
		CursorStore,
		import("@cursor/sdk").LocalAgentStore
	>();
	const agentOptions = (
		options: CursorAgentOptions,
		credential: CursorCredentialEnvelope,
		store: CursorStore,
		customTools: Readonly<Record<string, CursorCustomTool>> = {},
	): import("@cursor/sdk").AgentOptions => {
		const localStore = stores.get(store);
		if (!localStore) {
			throw new CursorSdkFailure({
				operation: "store.open",
				reason: "Cursor agent requires an open conduit-owned store",
			});
		}
		return {
			apiKey: Redacted.value(credential.apiKey),
			tools: [...options.tools],
			disallowedTools: [...options.disallowedTools],
			local: {
				cwd: options.cwd,
				dirs: [...options.dirs],
				store: localStore,
				settingSources: [...options.settingSources],
				sandboxOptions: options.sandboxOptions,
				autoReview: options.autoReview,
				customTools: Object.fromEntries(
					options.customToolNames.map((name) => {
						const tool = customTools[name];
						if (!tool) {
							throw new CursorSdkFailure({
								operation: "agent.options",
								reason: "Cursor custom tool handler is missing",
							});
						}
						return [
							name,
							{
								description: tool.description,
								inputSchema: tool.inputSchema,
								execute: (args, context) => tool.execute(args, context),
							} satisfies import("@cursor/sdk").SDKCustomTool,
						];
					}),
				),
				subagentInherit: options.subagentInherit,
				enableAgentRetries: true,
			},
		};
	};
	const wrapAgent = (agent: import("@cursor/sdk").SDKAgent): CursorAgent => {
		let closed: Promise<void> | undefined;
		return {
			id: agent.agentId,
			async send(prompt, options, onDelta) {
				const run = await call("agent.send", () =>
					agent.send(prompt, {
						model: {
							id: options.model.id,
							...(options.model.params
								? { params: [...options.model.params] }
								: {}),
						},
						mode: options.mode,
						...(options.local ? { local: options.local } : {}),
						onDelta: ({ update }) => onDelta(update),
					}),
				);
				let endStream: () => void = () => {};
				const streamEnded = new Promise<void>((resolve) => {
					endStream = resolve;
				});
				let waiting: Promise<unknown> | undefined;
				let streamFailure: CursorSdkFailure | undefined;
				const steer = run.steer?.bind(run);
				return {
					id: run.id,
					stream: (async function* () {
						try {
							yield* run.stream();
						} catch (cause) {
							streamFailure = cursorSdkFailure("run.stream", cause);
							throw streamFailure;
						} finally {
							endStream();
						}
					})(),
					wait() {
						const terminal = (waiting ??= call("run.wait", () => run.wait()));
						return Promise.race([
							terminal,
							streamEnded.then(async () => {
								await Promise.resolve();
								if (
									run.status !== "finished" &&
									run.status !== "cancelled" &&
									run.status !== "error"
								) {
									throw (
										streamFailure ??
										new CursorSdkFailure({
											operation: "run.wait",
											reason: "Cursor stream ended without a terminal status",
										})
									);
								}
								return terminal;
							}),
						]);
					},
					cancel: () => call("run.cancel", () => run.cancel()),
					...(steer
						? {
								steer: (text: string) => call("run.steer", () => steer(text)),
							}
						: {}),
				};
			},
			getUsage: () => call("agent.getUsage", () => agent.getUsage()),
			close() {
				return (closed ??= (async () => {
					// close() releases its lease without awaiting it in 1.0.37.
					// Await disposal first so store teardown cannot race that release.
					await agent[Symbol.asyncDispose]();
					agent.close();
				})());
			},
		};
	};
	return {
		async probeRuntime() {
			const [major = 0, minor = 0] = process.versions.node
				.split(".")
				.map(Number);
			if (major < 22 || (major === 22 && minor < 13)) {
				return {
					available: false,
					reason: "Cursor requires Node.js 22.13 or newer",
				};
			}
			try {
				await import("node:sqlite");
			} catch {
				return { available: false, reason: "Cursor requires node:sqlite" };
			}
			try {
				await load();
			} catch {
				return { available: false, reason: "Cursor SDK could not load" };
			}
			const platformPackage = `@cursor/sdk-${process.platform}-${process.arch}`;
			const extension = process.platform === "win32" ? ".exe" : "";
			for (const helper of ["cursorsandbox", "rg"]) {
				const relative = join(platformPackage, "bin", `${helper}${extension}`);
				let found = false;
				// Match the SDK's lookup roots, rather than its import location.
				for (const entry of [process.argv[1], process.execPath]) {
					if (!entry) continue;
					let directory = dirname(resolve(entry));
					while (true) {
						try {
							await access(
								join(directory, "node_modules", relative),
								constants.X_OK,
							);
							found = true;
							break;
						} catch {
							const parent = dirname(directory);
							if (parent === directory) break;
							directory = parent;
						}
					}
					if (found) break;
				}
				if (!found) {
					return {
						available: false,
						reason: `Cursor platform helper is missing: ${relative}`,
					};
				}
			}
			return { available: true };
		},
		async authLogin(options) {
			if (pendingLogin)
				throw new CursorSdkFailure({
					operation: "auth.login",
					reason: "The previous Cursor login is still finishing",
				});
			const operation = (async () => {
				const sdk = await load();
				const store = await credentialStore();
				// SDK 1.0.37 aborts polling, but does not check the signal while
				// minting/saving. Keep cancelled flows from replacing the SDK login.
				await sdk.Cursor.auth.login({
					...options,
					store: {
						load: () => store.load(),
						clear: () => store.clear(),
						async save(credential) {
							const previous = await store.load();
							options.signal.throwIfAborted();
							await store.save(credential);
							if (options.signal.aborted) {
								if (previous) await store.save(previous);
								else await store.clear();
								options.signal.throwIfAborted();
							}
						},
					},
				});
			})();
			pendingLogin = operation;
			try {
				// The SDK persists the key. Never return it beyond this adapter.
				await operation;
			} catch (cause) {
				throw cursorSdkFailure("auth.login", cause);
			} finally {
				pendingLogin = undefined;
			}
		},
		async authStatus() {
			try {
				return await (await load()).Cursor.auth.status({
					store: await credentialStore(),
				});
			} catch (cause) {
				throw cursorSdkFailure("auth.status", cause);
			}
		},
		async authLogout() {
			try {
				// A cancelled mint/save must settle before logout clears the store.
				await pendingLogin?.catch(() => {});
				await (await load()).Cursor.auth.logout({
					store: await credentialStore(),
				});
			} catch (cause) {
				throw cursorSdkFailure("auth.logout", cause);
			}
		},
		async storedCredential() {
			try {
				return await (await credentialStore()).load();
			} catch (cause) {
				throw cursorSdkFailure("credential.store", cause);
			}
		},
		async modelsList(credential) {
			try {
				const models = await (await load()).Cursor.models.list({
					apiKey: Redacted.value(credential.apiKey),
				});
				return models.map(({ id, displayName, parameters, variants }) => ({
					id,
					displayName,
					...(parameters ? { parameters } : {}),
					...(variants ? { variants } : {}),
				}));
			} catch (cause) {
				throw cursorSdkFailure("models.list", cause);
			}
		},
		async openStore(path, cwd) {
			const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");
			const localStore = await SqliteLocalAgentStore.open({
				workspaceRef: cwd,
				stateRoot: path,
			});
			let disposed: Promise<void> | undefined;
			const store: CursorStore = {
				dispose: () => (disposed ??= localStore.dispose()),
			};
			stores.set(store, localStore);
			return store;
		},
		async getActiveRun(agentId, store) {
			const localStore = stores.get(store);
			if (!localStore)
				throw new CursorSdkFailure({
					operation: "store.runs.get",
					reason: "Cursor requires an open conduit-owned store",
				});
			const agent = await localStore.agents.get({ agentId });
			if (!agent?.activeRunId) return undefined;
			return (
				(await localStore.runs.get({ agentId, runId: agent.activeRunId })) ??
				undefined
			);
		},
		async deleteAgent(agentId, cwd, store) {
			const localStore = stores.get(store);
			if (!localStore)
				throw new CursorSdkFailure({
					operation: "agent.delete",
					reason: "Cursor requires an open conduit-owned store",
				});
			const agent = await localStore.agents.get({ agentId });
			if (!agent) return;
			const options = { runtime: "local" as const, cwd, store: localStore };
			const api = (await load()).Agent;
			if (agent.activeRunId) {
				const run = await localStore.runs.get({
					agentId,
					runId: agent.activeRunId,
				});
				if (run?.status === "queued" || run?.status === "running")
					await api.cancelRun(run.runId, options);
			}
			await api.delete(agentId, options);
		},
		async primeSandbox(options, credential, store) {
			const agent = await (await load()).Agent.create(
				agentOptions(
					{
						...options,
						sandboxOptions: { enabled: true },
						customToolNames: [],
					},
					credential,
					store,
				),
			).catch((cause: unknown) => {
				throw cursorSdkFailure("sandbox.prime", cause);
			});
			try {
				// 1.0.37 initializes executors lazily. Its checked internal method
				// primes the sandbox without sending a hidden, billable prompt.
				if (
					!("getExecutor" in agent) ||
					typeof agent.getExecutor !== "function"
				) {
					throw new CursorSdkFailure({
						operation: "sandbox.prime",
						reason: "Cursor SDK sandbox initialization API changed",
					});
				}
				await agent.getExecutor().catch((cause: unknown) => {
					throw cursorSdkFailure("sandbox.prime", cause);
				});
			} finally {
				await wrapAgent(agent).close();
			}
		},
		async createAgent(options, credential, store, customTools) {
			return wrapAgent(
				await call("agent.create", async () =>
					(await load()).Agent.create(
						agentOptions(options, credential, store, customTools),
					),
				),
			);
		},
		async resumeAgent(id, options, credential, store, customTools) {
			return wrapAgent(
				await call("agent.resume", async () =>
					(await load()).Agent.resume(
						id,
						agentOptions(options, credential, store, customTools),
					),
				),
			);
		},
	};
}
