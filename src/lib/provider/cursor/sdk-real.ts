import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CursorSdkFailure, cursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorAgentOptions,
	CursorCredential,
	CursorCustomTool,
	CursorSdkPort,
	CursorStore,
} from "./sdk-port.js";

export function createRealCursorSdkPort(): CursorSdkPort {
	let sdk: Promise<typeof import("@cursor/sdk")> | undefined;
	const load = () => (sdk ??= import("@cursor/sdk"));
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
		credential: CursorCredential,
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
			apiKey: credential.apiKey,
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
						return [name, tool];
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
		async authStatus() {
			try {
				return await (await load()).Cursor.auth.status();
			} catch (cause) {
				throw cursorSdkFailure("auth.status", cause);
			}
		},
		async storedCredential() {
			try {
				const { FileCredentialStore } = await load();
				return await new FileCredentialStore().load();
			} catch (cause) {
				throw cursorSdkFailure("credential.store", cause);
			}
		},
		async modelsList(credential) {
			try {
				const models = await (await load()).Cursor.models.list({
					apiKey: credential.apiKey,
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
			);
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
				await agent.getExecutor().catch(() => {
					throw new CursorSdkFailure({
						operation: "sandbox.prime",
						reason:
							"Cursor sandbox initialization failed. Restart the runner after checking sandbox support.",
					});
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
