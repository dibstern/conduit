import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { CursorSdkFailure, cursorSdkFailure } from "./sdk-error.js";
import type {
	CursorAgent,
	CursorAgentOptions,
	CursorCustomTool,
	CursorSdkPort,
	CursorSendOptions,
	CursorStore,
} from "./sdk-port.js";

const SECRET_FIELD =
	/^(?:api[_-]?key|authorization|(?:access|refresh|session)[_-]?token|token|password|secret|(?:blob)?encryption[_-]?key|email)$/i;
const PRIVATE_HOME = /\/Users\/[^/\s"\\]+|\/home\/(?!test\b)[^/\s"\\]+/g;

interface CursorTraceMetadata {
	readonly scenario: string;
	readonly model: CursorSendOptions["model"];
}

export function createCursorSdkTrace(
	path: string | undefined,
	metadata?: CursorTraceMetadata,
) {
	const secrets = new Set<string>();
	const collectSecrets = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (SECRET_FIELD.test(key) && typeof child === "string" && child) {
				secrets.add(child);
			}
			collectSecrets(child);
		}
	};
	const redactText = (value: string): string => {
		let text = value.replace(PRIVATE_HOME, "/home/test");
		for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
		return text;
	};
	const redact = (value: unknown): unknown => {
		if (typeof value === "string") return redactText(value);
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value).map(([key, child]) => [
					key,
					SECRET_FIELD.test(key) ? "[REDACTED]" : redact(child),
				]),
			);
		}
		return value;
	};
	return {
		redactText,
		protect(secret: string) {
			if (secret) secrets.add(secret);
		},
		record(kind: string, data: unknown) {
			if (!path || path === "0") return;
			try {
				collectSecrets(data);
				mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
				let empty = false;
				try {
					empty = statSync(path).size === 0;
				} catch {
					empty = true;
				}
				const header = empty
					? `${JSON.stringify({ scenario: metadata?.scenario ?? "cursor-sdk-port", model: metadata?.model ?? "discovery", sdkVersion: "1.0.37", recordedAt: new Date().toISOString() })}\n`
					: "";
				appendFileSync(
					path,
					`${header}${JSON.stringify({ kind, at: new Date().toISOString(), data: redact(data) })}\n`,
					{ mode: 0o600 },
				);
			} catch {
				// Capturing diagnostics must not change SDK behavior.
			}
		},
	};
}

export function teeCursorSdkPort(
	port: CursorSdkPort,
	path: string | undefined,
	metadata?: CursorTraceMetadata,
): CursorSdkPort {
	const trace = createCursorSdkTrace(path, metadata);
	const authRequired = (cause: unknown) =>
		cause instanceof CursorSdkFailure && cause.authRequired
			? { authRequired: true as const }
			: {};
	if (!port.replay) {
		const apiKey = process.env["CURSOR_API_KEY"]?.trim();
		if (apiKey) trace.protect(apiKey);
	}
	const failure = (kind: string, cause: unknown): CursorSdkFailure => {
		const error = cursorSdkFailure(kind, cause);
		const reason = trace.redactText(error.reason);
		trace.record(`${kind}.error`, {
			...error.sdkError,
			message: reason,
			...authRequired(error),
		});
		return new CursorSdkFailure({ ...error, reason });
	};
	const call = async <A>(
		kind: string,
		options: unknown,
		operation: () => Promise<A>,
	): Promise<A> => {
		trace.record(`${kind}.call`, options);
		try {
			const result = await operation();
			if (
				result &&
				typeof result === "object" &&
				"apiKey" in result &&
				typeof result.apiKey === "string"
			) {
				trace.protect(result.apiKey);
			}
			trace.record(kind, result ?? null);
			return result;
		} catch (cause) {
			throw failure(kind, cause);
		}
	};
	const stores = new WeakMap<CursorStore, CursorStore>();
	const unwrapStore = (store: CursorStore) => stores.get(store) ?? store;
	const recordedOptions = (options: CursorAgentOptions) => ({
		tools: options.tools,
		disallowedTools: options.disallowedTools,
		credentialFingerprint: options.credentialFingerprint,
		local: {
			cwd: options.cwd,
			dirs: options.dirs,
			store: { stateRoot: options.storePath, workspaceRef: options.cwd },
			settingSources: options.settingSources,
			sandboxOptions: options.sandboxOptions,
			autoReview: options.autoReview,
			customTools: options.customToolNames,
			subagentInherit: options.subagentInherit,
			enableAgentRetries: true,
		},
	});
	const recordedTools = (
		tools: Readonly<Record<string, CursorCustomTool>> = {},
	) =>
		Object.fromEntries(
			Object.entries(tools).map(([toolName, tool]) => [
				toolName,
				{
					...tool,
					async execute(args, context) {
						trace.record("custom.start", { toolName, args, context });
						try {
							const result = await tool.execute(args, context);
							trace.record("custom.result", { toolName, context, result });
							return result;
						} finally {
							trace.record("custom.end", { toolName, context });
						}
					},
				} satisfies CursorCustomTool,
			]),
		);
	const wrapAgent = (agent: CursorAgent): CursorAgent => {
		let closed: Promise<void> | undefined;
		return {
			id: agent.id,
			async send(prompt, options, onDelta) {
				trace.record("send.options", { prompt, options });
				try {
					const run = await agent.send(prompt, options, (update) => {
						trace.record("delta", update);
						onDelta(update);
					});
					trace.record("run.handle", {
						id: run.id,
						agentId: agent.id,
						...(run.steer ? { steer: "function" } : {}),
					});
					const steer = run.steer?.bind(run);
					return {
						id: run.id,
						stream: (async function* () {
							try {
								for await (const message of run.stream) {
									trace.record("stream", message);
									yield message;
								}
								trace.record("stream.end", {});
							} catch (cause) {
								throw failure("stream", cause);
							}
						})(),
						async wait() {
							const result = await call("wait.result", {}, () => run.wait());
							if (
								result !== null &&
								typeof result === "object" &&
								"error" in result &&
								result.error !== null &&
								typeof result.error === "object" &&
								"message" in result.error &&
								typeof result.error.message === "string"
							) {
								return {
									...result,
									error: {
										...result.error,
										message: trace.redactText(result.error.message),
									},
								};
							}
							return result;
						},
						cancel: () => call("cancel", { runId: run.id }, () => run.cancel()),
						...(steer
							? {
									async steer(text: string) {
										trace.record("steer.call", { text });
										try {
											const outcome = await steer(text);
											trace.record("steer.ack", { outcome });
											return outcome;
										} catch (cause) {
											throw failure("steer", cause);
										}
									},
								}
							: {}),
					};
				} catch (cause) {
					throw failure("send", cause);
				}
			},
			getUsage: () =>
				call("usage", { agentId: agent.id }, () => agent.getUsage()),
			close() {
				return (closed ??= (async () => {
					await call("close", { agentId: agent.id }, () => agent.close());
					trace.record("agent.disposed", { agentId: agent.id });
				})());
			},
		};
	};
	return {
		...(port.replay ? { replay: true } : {}),
		probeRuntime: () => call("runtime.probe", {}, () => port.probeRuntime()),
		authLogin: (options) => {
			const onAbort = () =>
				trace.record("auth.login.abort", { aborted: options.signal.aborted });
			options.signal.addEventListener("abort", onAbort, { once: true });
			if (options.signal.aborted) onAbort();
			return call(
				"auth.login",
				{ openBrowser: options.openBrowser, apiKeyName: options.apiKeyName },
				() =>
					port.authLogin({
						...options,
						onLoginUrl(url) {
							trace.record("auth.loginUrl", url);
							options.onLoginUrl(url);
						},
					}),
			).finally(() => options.signal.removeEventListener("abort", onAbort));
		},
		authStatus: () => call("auth.status", {}, () => port.authStatus()),
		authLogout: () => call("auth.logout", {}, () => port.authLogout()),
		storedCredential: () =>
			call("credential.store", {}, () => port.storedCredential()),
		modelsList: (credential) => {
			trace.protect(credential.apiKey);
			return call("models.list", { credential }, () =>
				port.modelsList(credential),
			);
		},
		async openStore(path, cwd) {
			const store = await port.openStore(path, cwd);
			trace.record("store.open", { stateRoot: path, workspaceRef: cwd });
			let disposed: Promise<void> | undefined;
			const wrapped: CursorStore = {
				dispose() {
					return (disposed ??= (async () => {
						await store.dispose();
						trace.record("store.disposed", { stateRoot: path });
						if (port.replay)
							trace.record("store.disposed.handles", { handles: [] });
					})());
				},
			};
			stores.set(wrapped, store);
			return wrapped;
		},
		getActiveRun: (agentId, store) =>
			call("store.active-run", { agentId }, () =>
				port.getActiveRun(agentId, unwrapStore(store)),
			),
		deleteAgent: (agentId, cwd, store) =>
			call("agent.delete", { agentId, cwd }, () =>
				port.deleteAgent(agentId, cwd, unwrapStore(store)),
			),
		async primeSandbox(options, credential, store) {
			trace.protect(credential.apiKey);
			trace.record(
				"sandbox.prime.options",
				recordedOptions({
					...options,
					sandboxOptions: { enabled: true },
					customToolNames: [],
				}),
			);
			try {
				await port.primeSandbox(options, credential, unwrapStore(store));
				trace.record("sandbox.prime", {});
			} catch (cause) {
				const reason =
					"Cursor sandbox initialization failed. Restart the runner after checking sandbox support.";
				trace.record("sandbox.prime.error", {
					message: reason,
					...authRequired(cause),
				});
				throw new CursorSdkFailure({
					operation: "sandbox.prime",
					reason,
					...authRequired(cause),
				});
			}
		},
		async createAgent(options, credential, store, customTools) {
			trace.protect(credential.apiKey);
			trace.record("create.options", recordedOptions(options));
			try {
				const agent = await port.createAgent(
					options,
					credential,
					unwrapStore(store),
					recordedTools(customTools),
				);
				trace.record("created", { agentId: agent.id });
				return wrapAgent(agent);
			} catch (cause) {
				throw failure("create", cause);
			}
		},
		async resumeAgent(id, options, credential, store, customTools) {
			trace.protect(credential.apiKey);
			trace.record("resume.options", {
				agentId: id,
				...recordedOptions(options),
			});
			try {
				const agent = await port.resumeAgent(
					id,
					options,
					credential,
					unwrapStore(store),
					recordedTools(customTools),
				);
				trace.record("resumed", { agentId: agent.id });
				return wrapAgent(agent);
			} catch (cause) {
				throw failure("resume", cause);
			}
		},
	};
}
