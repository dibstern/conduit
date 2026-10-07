import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ResolvedSettings,
	ResolveSettingsOptions,
	Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	type CallToolResult,
	CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ClaudeSubagentSdk } from "../../src/lib/provider/claude/claude-subagent-materializer.js";
import type {
	Options,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "../../src/lib/provider/claude/types.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";

export type ProcessMark =
	| {
			kind: "mcp-tools";
			prompt: string;
			serverKey: string;
			serverName: string;
			toolNames: string[];
	  }
	| {
			kind: "mcp-tool-call";
			prompt: string;
			toolName: string;
			arguments: Record<string, unknown>;
			result: CallToolResult;
	  }
	| {
			kind:
				| "runner-hello-pending"
				| "runner-idle-exit-started"
				| "runner-spawned";
			pid: number;
	  }
	| { kind: "runner-end-selected"; sessionId: string }
	| { kind: "receipt"; prompt: string; at: string }
	| {
			kind: "enqueue";
			prompt: string;
			at: string;
			queryId: string;
			promptIndex: number;
			liveOptions: {
				model?: string;
				effort?: Options["effort"];
				permissionMode?: Options["permissionMode"];
			};
	  }
	| { kind: "emit"; prompt: string; text: string; at: string }
	| { kind: "approval"; prompt: string; behavior: "allow" | "deny" }
	| { kind: "pre-assistant-held"; prompt: string; queryId: string }
	| { kind: "assistant-held"; prompt: string; queryId: string }
	| {
			kind: "resume-rejected";
			prompt: string;
			queryId: string;
			sessionId: string;
	  }
	| {
			kind: "background-work";
			phase: "started" | "completed";
			queryId: string;
			pid: number;
			at: string;
	  }
	| {
			kind: "notification-turn";
			phase: "stream-held" | "snapshot" | "held" | "completed";
			queryId: string;
			pid: number;
			messageId: string;
			snapshotUuid?: string;
			at: string;
	  }
	| {
			kind:
				| "initialization-held"
				| "initialization-ready"
				| "initialization-failed"
				| "query-closed"
				| "system-init";
			queryId: string;
			at: string;
	  }
	| {
			kind: "query";
			queryId: string;
			at: string;
			sessionId: string;
			pid: number;
			optionsJson: string;
			effectiveSettingsJson: string;
			options: {
				model?: string;
				effort?: Options["effort"];
				permissionMode?: Options["permissionMode"];
				settings?: { disableAllHooks?: boolean };
			};
			env: Readonly<Record<string, string | undefined>>;
	  }
	| {
			kind: "runner-started";
			pid: number;
			sessionId: string;
			socketPath: string;
			buildId: string;
			protocolVersion: number;
	  }
	| { kind: "runner-command"; commandId: string; type: string }
	| {
			kind: "runner-upgrade";
			phase: "warming" | "cancelled" | "failed" | "switched";
			sessionId: string;
			oldPid: number;
			newPid?: number;
			at: string;
	  }
	| {
			kind: "runner-snapshot";
			pid: number;
			sessionId: string;
			snapshotJson: string;
	  }
	| {
			kind: "runtime-sink";
			phase: "allocated" | "released";
			sinkId: string;
			sessionId: string;
			activeSinks: number;
	  }
	| {
			kind: "subagent-finalizer";
			phase: "started" | "completed";
			pid: number;
			parentClaudeSessionId: string;
			sdkSubagentId: string;
			at: string;
	  }
	| {
			kind: "settings-resolved";
			pid: number;
			effectiveSettingsJson: string;
	  }
	| {
			kind: "query-update";
			queryId: string;
			model?: string;
			effort?: Options["effort"];
			permissionMode?: Options["permissionMode"];
	  }
	| { kind: "runner-spawned"; pid: number; socketPath: string };

function currentRequest(prompt: string): string {
	const end = "[End conduit context handoff]\n\n";
	const boundary = prompt.indexOf(end);
	return prompt.startsWith("[Conduit context handoff]") && boundary >= 0
		? prompt.slice(boundary + end.length)
		: prompt;
}

export function responseChunks(prompt: string): string[] {
	const visiblePrompt = currentRequest(prompt);
	if (visiblePrompt === "approval-account-switch-history")
		return ["OMIT-THIS-ASSISTANT-CONTEXT ".repeat(900), "\nHistory complete."];
	if (visiblePrompt.startsWith("approval-thread-read-history-"))
		return [`OMIT-${visiblePrompt} `.repeat(900), "\nHistory complete."];
	return [
		`Echo(${visiblePrompt}): `,
		`stream(${visiblePrompt}) `,
		`done(${visiblePrompt}).`,
	];
}

function mark(message: ProcessMark): void {
	const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
	if (proof) appendFileSync(proof, `${JSON.stringify(message)}\n`);
	const send = () => {
		if (process.connected)
			process.send?.({ channel: "conduit-process-test", ...message });
	};
	const delay =
		message.kind === "enqueue"
			? Number(process.env["CONDUIT_TEST_ENQUEUE_MARK_DELAY_MS"] ?? 0)
			: 0;
	if (delay > 0) setTimeout(send, delay);
	else send();
}

function stream(sessionId: string, event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		session_id: sessionId,
		uuid: randomUUID(),
		parent_tool_use_id: null,
		event,
	} as unknown as SDKMessage;
}

function mergeSettings(
	base: Record<string, unknown>,
	settings: Record<string, unknown>,
): Record<string, unknown> {
	const merged = { ...base };
	for (const [key, value] of Object.entries(settings)) {
		const previous = merged[key];
		merged[key] =
			previous &&
			value &&
			typeof previous === "object" &&
			typeof value === "object" &&
			!Array.isArray(previous) &&
			!Array.isArray(value)
				? mergeSettings(
						previous as Record<string, unknown>,
						value as Record<string, unknown>,
					)
				: value;
	}
	return merged;
}

function fileSettings(
	options: ResolveSettingsOptions = {},
	configDir = process.env["CLAUDE_CONFIG_DIR"],
): ResolvedSettings {
	const cwd = options.cwd ?? process.cwd();
	const paths = {
		user: configDir ? join(configDir, "settings.json") : undefined,
		project: join(cwd, ".claude/settings.json"),
		local: join(cwd, ".claude/settings.local.json"),
	};
	let effective: Record<string, unknown> = {};
	const sources: ResolvedSettings["sources"] = [];
	const provenance: Record<string, { source: string; path: string }> = {};
	for (const source of options.settingSources ?? ["user", "project", "local"]) {
		const path = paths[source];
		if (!path || !existsSync(path)) continue;
		const settings = JSON.parse(readFileSync(path, "utf8")) as Settings;
		sources.push({ source, settings, path });
		effective = mergeSettings(effective, settings);
		for (const key of Object.keys(settings)) provenance[key] = { source, path };
	}
	return {
		effective: effective as Settings,
		sources,
		provenance: provenance as ResolvedSettings["provenance"],
	};
}

export const resolveSettings: typeof import("@anthropic-ai/claude-agent-sdk").resolveSettings =
	async (options) => {
		const resolved = fileSettings(options);
		mark({
			kind: "settings-resolved",
			pid: process.pid,
			effectiveSettingsJson: JSON.stringify(resolved.effective),
		});
		return resolved;
	};

export const claudeSubagentSdk: ClaudeSubagentSdk = {
	listSubagents: async () => [],
	getSubagentMessages: async (parentClaudeSessionId, sdkSubagentId) => {
		const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
		if (!proof || sdkSubagentId !== "review-finalizer-task") return [];
		mark({
			kind: "subagent-finalizer",
			phase: "started",
			pid: process.pid,
			parentClaudeSessionId,
			sdkSubagentId,
			at: process.hrtime.bigint().toString(),
		});
		while (!existsSync(join(dirname(proof), "release-subagent-finalizer")))
			await new Promise<void>((done) => setTimeout(done, 20));
		mark({
			kind: "subagent-finalizer",
			phase: "completed",
			pid: process.pid,
			parentClaudeSessionId,
			sdkSubagentId,
			at: process.hrtime.bigint().toString(),
		});
		return [
			{
				type: "assistant",
				uuid: "review-finalizer-message",
				session_id: sdkSubagentId,
				parent_tool_use_id: "review-finalizer-tool",
				parent_agent_id: null,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "late child finalizer result" }],
				},
			},
		];
	},
};

let initializationAttempts = 0;

function query(params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options?: Options;
}): Query {
	const sessionId = params.options?.resume ?? randomUUID();
	const queryId = randomUUID();
	let liveModel = params.options?.model;
	let liveEffort = params.options?.effort;
	let livePermissionMode = params.options?.permissionMode;
	let closed = false;
	let promptIndex = 0;
	let rejectedPrompt: string | undefined;
	let initializationFinished = false;
	let rejectInitialization: (error: Error) => void = () => {};
	const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
	const consumeMarker = (name: string): boolean => {
		if (!proof) return false;
		try {
			unlinkSync(join(dirname(proof), name));
			return true;
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "ENOENT"
			)
				throw error;
			return false;
		}
	};
	const failNext = consumeMarker("fail-next-initialization");
	const holdNext = consumeMarker("hold-next-initialization");
	const fails =
		++initializationAttempts <=
			Number(process.env["CONDUIT_TEST_QUERY_INITIALIZATION_FAILURES"] ?? 0) ||
		failNext;
	const delayMs = Number(
		process.env["CONDUIT_TEST_QUERY_INITIALIZATION_DELAY_MS"] ?? 0,
	);
	let initializationTimer: ReturnType<typeof setTimeout> | undefined;
	const settings = params.options?.settings;
	const flagSettings =
		typeof settings === "string"
			? (JSON.parse(readFileSync(settings, "utf8")) as Settings)
			: (settings ?? {});
	const effectiveSettings = mergeSettings(
		fileSettings(
			{
				...(params.options?.cwd === undefined
					? {}
					: { cwd: params.options.cwd }),
				...(params.options?.settingSources === undefined
					? {}
					: { settingSources: params.options.settingSources }),
			},
			params.options?.env?.["CLAUDE_CONFIG_DIR"],
		).effective,
		flagSettings,
	);
	mark({
		kind: "query",
		queryId,
		at: process.hrtime.bigint().toString(),
		sessionId,
		pid: process.pid,
		effectiveSettingsJson: JSON.stringify(effectiveSettings),
		optionsJson: JSON.stringify(
			Object.fromEntries(
				Object.entries(params.options ?? {}).filter(
					([key]) => !["abortController", "canUseTool", "resume"].includes(key),
				),
			),
			(key, value: unknown) => (key === "instance" ? undefined : value),
		),
		options: {
			...(params.options?.model ? { model: params.options.model } : {}),
			...(params.options?.effort ? { effort: params.options.effort } : {}),
			...(params.options?.permissionMode
				? { permissionMode: params.options.permissionMode }
				: {}),
			...(settings &&
			typeof settings === "object" &&
			typeof settings.disableAllHooks === "boolean"
				? { settings: { disableAllHooks: settings.disableAllHooks } }
				: {}),
		},
		env: Object.fromEntries(
			[
				"CONDUIT_ENV_PROOF",
				"PATH",
				"CLAUDE_CONFIG_DIR",
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_MODEL",
				"CLAUDE_AGENT_SDK_CLIENT_APP",
				"ENABLE_CLAUDEAI_MCP_SERVERS",
			].map((key) => [key, params.options?.env?.[key]]),
		),
	});
	// Like the SDK, query construction starts initialization without input. The
	// public system/init message remains a first-prompt event, not readiness.
	const initialization = new Promise<Record<string, never>>((done, fail) => {
		rejectInitialization = fail;
		if (holdNext)
			mark({
				kind: "initialization-held",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
		const finish = () => {
			if (initializationFinished) return;
			if (
				holdNext &&
				proof &&
				!existsSync(join(dirname(proof), "release-held-initialization"))
			) {
				initializationTimer = setTimeout(finish, 20);
				return;
			}
			initializationFinished = true;
			mark({
				kind: fails ? "initialization-failed" : "initialization-ready",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
			if (fails) fail(new Error("Synthetic Claude initialization failure"));
			else done({});
		};
		if (delayMs > 0) initializationTimer = setTimeout(finish, delayMs);
		else finish();
	});
	// A caller may attach the readiness barrier on the next tick.
	void initialization.catch(() => {});
	const messages = (async function* (): AsyncGenerator<SDKMessage> {
		await initialization;
		for await (const input of params.prompt) {
			const at = process.hrtime.bigint().toString();
			if (closed) return;
			const content = input.message.content;
			const prompt =
				typeof content === "string"
					? content
					: content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");
			const request = currentRequest(prompt);
			const optionsFile = process.env["CONDUIT_TEST_CLAUDE_OPTIONS_FILE"];
			if (optionsFile) {
				const seen = new WeakSet<object>();
				const record = JSON.stringify(
					{
						pid: process.pid,
						prompt,
						configDir:
							params.options?.env?.["CLAUDE_CONFIG_DIR"] ??
							process.env["CLAUDE_CONFIG_DIR"] ??
							null,
						resumeId: params.options?.resume ?? null,
						options: params.options ?? {},
					},
					(key, value: unknown) => {
						if (key === "instance") return undefined;
						if (typeof value === "bigint") return value.toString();
						if (typeof value === "object" && value !== null) {
							if (seen.has(value)) return undefined;
							seen.add(value);
						}
						return value;
					},
				);
				appendFileSync(optionsFile, `${record}\n`);
			}
			mark({
				kind: "enqueue",
				prompt,
				at,
				queryId,
				promptIndex: ++promptIndex,
				liveOptions: {
					...(liveModel === undefined ? {} : { model: liveModel }),
					...(liveEffort === undefined ? {} : { effort: liveEffort }),
					...(livePermissionMode === undefined
						? {}
						: { permissionMode: livePermissionMode }),
				},
			});
			const rejectedResume = proof
				? join(dirname(proof), "rejected-resume-session-id")
				: undefined;
			if (
				params.options?.resume &&
				rejectedResume &&
				existsSync(rejectedResume) &&
				readFileSync(rejectedResume, "utf8") === params.options.resume
			)
				rejectedPrompt = prompt;
			if (request === "fail-before-assistant-restart") {
				const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
				if (!proof) throw new Error("Missing pre-assistant failure gate");
				mark({ kind: "pre-assistant-held", prompt, queryId });
				const release = join(dirname(proof), "release-before-assistant");
				while (!existsSync(release))
					await new Promise<void>((done) => setTimeout(done, 20));
				throw new Error("Harness failure before assistant message");
			}
			if (promptIndex === 1) {
				mark({
					kind: "system-init",
					queryId,
					at: process.hrtime.bigint().toString(),
				});
				yield {
					type: "system",
					subtype: "init",
					session_id: sessionId,
					uuid: randomUUID(),
					cwd: params.options?.cwd ?? "",
					apiKeySource: "none",
					claude_code_version: "process-test",
					tools: ["Bash"],
					mcp_servers: [],
					model: params.options?.model ?? "claude-sonnet-4",
					permissionMode: params.options?.permissionMode ?? "default",
					slash_commands: [],
					output_style: "default",
					skills: [],
					plugins: [],
				} as unknown as SDKMessage;
			}
			if (request === "thread-read-omitted-history") {
				const serverKey = "conduit";
				const server = params.options?.mcpServers?.[serverKey];
				if (server?.type !== "sdk")
					throw new Error("The thread reader MCP server was not registered");
				const client = new Client({
					name: "fake-claude-sdk",
					version: "1.0.0",
				});
				const [clientTransport, serverTransport] =
					InMemoryTransport.createLinkedPair();
				await server.instance.connect(serverTransport);
				try {
					await client.connect(clientTransport);
					const { tools } = await client.listTools();
					mark({
						kind: "mcp-tools",
						prompt,
						serverKey,
						serverName: server.name,
						toolNames: tools.map(({ name }) => `mcp__${serverKey}__${name}`),
					});
					const tool = tools.find(({ name }) => name === "conduit_thread_read");
					if (!tool)
						throw new Error("The thread reader MCP tool was not listed");
					let args: { cursor?: string; textOffset?: number; limit: number } = {
						limit: 1,
					};
					let reachedEnd = false;
					for (let index = 0; index < 32; index++) {
						const result = CallToolResultSchema.parse(
							await client.callTool({ name: tool.name, arguments: args }),
						);
						mark({
							kind: "mcp-tool-call",
							prompt,
							toolName: `mcp__${serverKey}__${tool.name}`,
							arguments: args,
							result,
						});
						const page: unknown = JSON.parse(
							result.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join(""),
						);
						if (
							!page ||
							typeof page !== "object" ||
							!("items" in page) ||
							!Array.isArray(page.items)
						)
							throw new Error(
								"The thread reader returned an invalid history page",
							);
						if (
							!("nextCursor" in page) ||
							typeof page.nextCursor !== "string"
						) {
							reachedEnd = true;
							break;
						}
						args = {
							cursor: page.nextCursor,
							...("nextTextOffset" in page &&
							typeof page.nextTextOffset === "number"
								? { textOffset: page.nextTextOffset }
								: {}),
							limit: 1,
						};
					}
					if (!reachedEnd)
						throw new Error("The thread reader did not finish paging");
					const invalid = { cursor: "invalid-thread-cursor", limit: 1 };
					const result = CallToolResultSchema.parse(
						await client.callTool({ name: tool.name, arguments: invalid }),
					);
					mark({
						kind: "mcp-tool-call",
						prompt,
						toolName: `mcp__${serverKey}__${tool.name}`,
						arguments: invalid,
						result,
					});
				} finally {
					await client.close();
				}
			}
			const messageId = randomUUID();
			yield stream(sessionId, {
				type: "message_start",
				message: { id: messageId, role: "assistant", content: [] },
			});
			yield stream(sessionId, {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			});
			for (const [index, text] of responseChunks(prompt).entries()) {
				if (request === "upgrade-long-turn" && index === 1 && proof) {
					const release = join(dirname(proof), "release-upgrade-turn");
					while (!existsSync(release) && !closed)
						await new Promise<void>((done) => setTimeout(done, 20));
					if (closed) return;
				}
				if (request.startsWith("restart-"))
					await new Promise<void>((done) => setTimeout(done, 120));
				const event = stream(sessionId, {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text },
				});
				mark({
					kind: "emit",
					prompt,
					text,
					at: process.hrtime.bigint().toString(),
				});
				yield event;
			}
			yield stream(sessionId, { type: "content_block_stop", index: 0 });
			if (request.startsWith("stall-"))
				await new Promise<void>((done) => {
					params.options?.abortController?.signal.addEventListener(
						"abort",
						() => done(),
						{ once: true },
					);
				});
			if (request.startsWith("question-")) {
				if (!params.options?.canUseTool)
					throw new Error("Missing question bridge");
				await params.options.canUseTool(
					"AskUserQuestion",
					{
						questions: [
							{
								question: "Continue?",
								header: "Runner",
								options: [
									{ label: "Continue", description: "Continue the turn" },
								],
							},
						],
					},
					{
						signal:
							params.options.abortController?.signal ??
							new AbortController().signal,
						toolUseID: randomUUID(),
						requestId: randomUUID(),
					},
				);
			}
			if (request.startsWith("approval-")) {
				const toolUseID = randomUUID();
				const handoffHistory =
					request === "approval-account-switch-history" ||
					request.startsWith("approval-thread-read-history-");
				const toolName = handoffHistory ? "Read" : "Bash";
				const toolInput = handoffHistory
					? { file_path: "/account-switch-general-result.txt" }
					: { command: "printf harness-approved" };
				yield stream(sessionId, {
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "tool_use",
						id: toolUseID,
						name: toolName,
						input: toolInput,
					},
				});
				yield stream(sessionId, { type: "content_block_stop", index: 1 });
				if (!params.options?.canUseTool)
					throw new Error("Missing canUseTool bridge");
				const approval = await params.options.canUseTool(toolName, toolInput, {
					signal:
						params.options.abortController?.signal ??
						new AbortController().signal,
					toolUseID,
					requestId: randomUUID(),
					...(request === "approval-restart"
						? {
								suggestions: [
									{
										type: "addRules" as const,
										rules: [
											{
												toolName: "Bash",
												ruleContent: "printf harness-approved",
											},
										],
										behavior: "allow" as const,
										destination: "session" as const,
									},
								],
							}
						: {}),
				});
				if (!approval) throw new Error("Approval bridge returned no decision");
				mark({
					kind: "approval",
					prompt,
					behavior: approval.behavior,
					...(approval.behavior === "allow" && approval.updatedPermissions
						? { updatedPermissions: approval.updatedPermissions }
						: {}),
				});
				yield {
					type: "user",
					uuid: randomUUID(),
					session_id: sessionId,
					parent_tool_use_id: null,
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: toolUseID,
								content:
									approval.behavior === "allow"
										? handoffHistory
											? "ACCOUNT-SWITCH-GENERAL-TOOL-RESULT"
											: "harness-approved"
										: "harness-denied",
								is_error: approval.behavior !== "allow",
							},
						],
					},
				} as unknown as SDKMessage;
			}
			if (
				request.startsWith("failure-") ||
				request.startsWith("approval-failure-")
			)
				throw new Error("Harness adapter failure");
			if (
				request === "upgrade-background-work" ||
				request.startsWith("notification-parent-turn")
			) {
				mark({
					kind: "background-work",
					phase: "started",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [
						{
							task_id: "upgrade-background-task",
							task_type: "local_bash",
							description: "Live background task",
							ambient: request === "notification-parent-turn-during-warm",
						},
					],
				} as unknown as SDKMessage;
			}
			if (request === "review-subagent-finalizer") {
				yield {
					type: "system",
					subtype: "task_started",
					uuid: randomUUID(),
					session_id: sessionId,
					task_id: "review-finalizer-task",
					tool_use_id: "review-finalizer-tool",
					description: "Finalizer child",
					task_type: "local_agent",
				} as unknown as SDKMessage;
				yield {
					type: "system",
					subtype: "task_notification",
					uuid: randomUUID(),
					session_id: sessionId,
					task_id: "review-finalizer-task",
					tool_use_id: "review-finalizer-tool",
					status: "completed",
					output_file: proof
						? join(dirname(proof), "review-finalizer-task.output")
						: "review-finalizer-task.output",
					summary: "Task complete; transcript catch-up pending",
				} as unknown as SDKMessage;
			}
			yield {
				type: "assistant",
				uuid: messageId,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					id: messageId,
					role: "assistant",
					content: [{ type: "text", text: responseChunks(prompt).join("") }],
				},
			} as unknown as SDKMessage;
			if (request === "terminal-replay-interrupt") {
				mark({ kind: "assistant-held", prompt, queryId });
				while (!closed) await new Promise<void>((done) => setTimeout(done, 20));
				return;
			}
			yield {
				type: "result",
				subtype: "success",
				uuid: randomUUID(),
				session_id: sessionId,
				is_error: false,
				duration_ms: 0,
				duration_api_ms: 0,
				num_turns: 1,
				result: responseChunks(prompt).join(""),
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {
					input_tokens: 1,
					output_tokens: 3,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
				modelUsage: {},
				permission_denials: [],
			} as unknown as SDKMessage;
			if (request === "restart-background-work") {
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [
						{
							task_id: "restart-background-task",
							task_type: "local_bash",
							description: "Background restart proof",
							ambient: false,
						},
					],
				} as unknown as SDKMessage;
				mark({
					kind: "background-work",
					phase: "started",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
				if (proof) {
					const change = join(dirname(proof), "restart-background-change");
					while (!existsSync(change) && !closed)
						await new Promise<void>((done) => setTimeout(done, 20));
					if (closed || readFileSync(change, "utf8") === "end") return;
					yield {
						type: "system",
						subtype: "background_tasks_changed",
						session_id: sessionId,
						uuid: randomUUID(),
						tasks:
							readFileSync(change, "utf8") === "replace"
								? [
										{
											task_id: "replacement-background-task",
											task_type: "local_agent",
											description: "Latest background snapshot",
											ambient: false,
										},
									]
								: [],
					} as unknown as SDKMessage;
				}
			}
			if (request === "upgrade-background-work" && proof) {
				const release = join(dirname(proof), "release-upgrade-background");
				while (!existsSync(release) && !closed)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [],
				} as unknown as SDKMessage;
				mark({
					kind: "background-work",
					phase: "completed",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
			}
			if (request.startsWith("notification-parent-turn") && proof) {
				const release = join(dirname(proof), "release-notification-parent");
				while (!existsSync(release) && !closed)
					await new Promise<void>((done) => setTimeout(done, 20));
				if (closed) return;
				yield {
					type: "system",
					subtype: "background_tasks_changed",
					session_id: sessionId,
					uuid: randomUUID(),
					tasks: [],
				} as unknown as SDKMessage;
				yield {
					type: "system",
					subtype: "task_notification",
					session_id: sessionId,
					uuid: randomUUID(),
					task_id: "upgrade-background-task",
					status: "completed",
					output_file: join(dirname(proof), "notification-parent.output"),
					summary: "Background task complete; parent is continuing",
				} as unknown as SDKMessage;
				mark({
					kind: "background-work",
					phase: "completed",
					queryId,
					pid: process.pid,
					at: process.hrtime.bigint().toString(),
				});
				const resultRelease = join(
					dirname(proof),
					"release-notification-result",
				);
				let parentMessageId = "";
				for (const text of [
					"Notification parent message.",
					"Notification parent finished.",
				]) {
					const beforeSnapshot =
						request === "notification-parent-turn-before-snapshot";
					parentMessageId = beforeSnapshot
						? `msg_${randomUUID()}`
						: randomUUID();
					const snapshotUuid = beforeSnapshot ? randomUUID() : parentMessageId;
					yield stream(sessionId, {
						type: "message_start",
						message: { id: parentMessageId, role: "assistant", content: [] },
					});
					yield stream(sessionId, {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					});
					yield stream(sessionId, {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text },
					});
					yield stream(sessionId, { type: "content_block_stop", index: 0 });
					yield stream(sessionId, { type: "message_stop" });
					if (beforeSnapshot && text === "Notification parent message.") {
						mark({
							kind: "notification-turn",
							phase: "stream-held",
							queryId,
							pid: process.pid,
							messageId: parentMessageId,
							snapshotUuid,
							at: process.hrtime.bigint().toString(),
						});
						const snapshotRelease = join(
							dirname(proof),
							"release-notification-snapshot",
						);
						while (!existsSync(snapshotRelease) && !closed)
							await new Promise<void>((done) => setTimeout(done, 20));
						if (closed) return;
					}
					yield {
						type: "assistant",
						uuid: snapshotUuid,
						session_id: sessionId,
						parent_tool_use_id: null,
						message: {
							id: parentMessageId,
							role: "assistant",
							content: [{ type: "text", text }],
						},
					} as unknown as SDKMessage;
					if (beforeSnapshot)
						mark({
							kind: "notification-turn",
							phase: "snapshot",
							queryId,
							pid: process.pid,
							messageId: parentMessageId,
							snapshotUuid,
							at: process.hrtime.bigint().toString(),
						});
					if (text === "Notification parent message.") {
						mark({
							kind: "notification-turn",
							phase: "held",
							queryId,
							pid: process.pid,
							messageId: parentMessageId,
							at: process.hrtime.bigint().toString(),
						});
						while (!existsSync(resultRelease) && !closed)
							await new Promise<void>((done) => setTimeout(done, 20));
						if (closed) return;
					}
				}
				yield {
					type: "result",
					subtype: "success",
					uuid: randomUUID(),
					session_id: sessionId,
					is_error: false,
					duration_ms: 0,
					duration_api_ms: 0,
					num_turns: 1,
					result: "Notification parent finished.",
					stop_reason: "end_turn",
					total_cost_usd: 0,
					usage: {
						input_tokens: 1,
						output_tokens: 3,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
					modelUsage: {},
					permission_denials: [],
				} as unknown as SDKMessage;
				mark({
					kind: "notification-turn",
					phase: "completed",
					queryId,
					pid: process.pid,
					messageId: parentMessageId,
					at: process.hrtime.bigint().toString(),
				});
			}
			if (request === "ambient-idle") {
				while (!closed) {
					await new Promise<void>((done) => setTimeout(done, 50));
					yield {
						type: "system",
						subtype: "background_tasks_changed",
						session_id: sessionId,
						uuid: randomUUID(),
						tasks: [
							{
								task_id: "watcher",
								task_type: "local_bash",
								description: "watch",
								ambient: true,
							},
						],
					} as unknown as SDKMessage;
				}
			}
		}
	})();
	// The adapter consumes the iterable and these control methods; the full SDK
	// interface also contains unrelated account/MCP methods that this fake never uses.
	return Object.assign(messages, {
		[Symbol.asyncIterator]: () => ({
			next: () => {
				if (rejectedPrompt) {
					mark({
						kind: "resume-rejected",
						prompt: rejectedPrompt,
						queryId,
						sessionId,
					});
					return Promise.reject(
						new Error(`Claude session not found: ${sessionId}`),
					);
				}
				return messages.next();
			},
			return: () => messages.return(undefined),
		}),
		initializationResult: () => initialization,
		close: () => {
			if (closed) return;
			closed = true;
			clearTimeout(initializationTimer);
			if (!initializationFinished) {
				initializationFinished = true;
				rejectInitialization(
					new Error("Claude query closed before initialization"),
				);
			}
			mark({
				kind: "query-closed",
				queryId,
				at: process.hrtime.bigint().toString(),
			});
		},
		interrupt: async () => {},
		setModel: async (model?: string) => {
			liveModel = model;
			mark({
				kind: "query-update",
				queryId,
				...(model === undefined ? {} : { model }),
			});
		},
		setPermissionMode: async (permissionMode: Options["permissionMode"]) => {
			livePermissionMode = permissionMode;
			mark({
				kind: "query-update",
				queryId,
				...(permissionMode === undefined ? {} : { permissionMode }),
			});
		},
		applyFlagSettings: async (settings: {
			effortLevel?: Options["effort"];
		}) => {
			liveEffort = settings.effortLevel;
			mark({
				kind: "query-update",
				queryId,
				...(liveEffort === undefined ? {} : { effort: liveEffort }),
			});
		},
	}) as unknown as Query;
}

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query,
	fork: {
		readTranscript: async () => {
			throw new Error("Process harness does not replay Claude forks");
		},
		forkSession: async () => {
			throw new Error("Process harness does not replay Claude forks");
		},
	},
	titleQuery: async function* () {
		yield {
			type: "result",
			subtype: "success",
			result: "Process harness session",
		};
	},
};
