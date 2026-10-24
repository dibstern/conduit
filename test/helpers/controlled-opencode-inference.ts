import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";

export const CONTROLLED_MODEL = {
	providerID: "conduit-contract",
	modelID: "main",
} as const;
export const CONTROLLED_MODEL_ID = `${CONTROLLED_MODEL.providerID}/${CONTROLLED_MODEL.modelID}`;
const AUXILIARY_MODEL_ID = `${CONTROLLED_MODEL.providerID}/auxiliary`;

interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface ChatRequest {
	model: string;
	stream: true;
	messages: {
		role: string;
		content?: string | { type: string; text?: string }[] | null;
		tool_calls?: ToolCall[];
		tool_call_id?: string;
	}[];
	tools?: {
		type: string;
		function: {
			name: string;
			parameters: { properties?: Record<string, unknown>; required?: string[] };
		};
	}[];
}

function messageText(message: ChatRequest["messages"][number]): string {
	return typeof message.content === "string"
		? message.content
		: (message.content ?? []).map((part) => part.text ?? "").join("\n");
}

// Script only inference. OpenCode owns tool execution, asks, events and history.
function answer(request: ChatRequest): {
	content: string | null;
	tool_calls?: ToolCall[];
} {
	if (!Array.isArray(request.messages) || request.messages.length === 0) {
		throw new Error("Expected chat messages");
	}
	if (request.model === "auxiliary") return { content: "Contract test" };
	if (request.model !== CONTROLLED_MODEL.modelID) {
		throw new Error(`Unsupported model ${request.model}`);
	}
	const user = request.messages
		.filter((message) => message.role === "user")
		.map(messageText)
		.join("\n");
	const permission = user.includes(
		"Use the bash tool exactly once to run: printf 'global-stream-contract\\n'. Do not use any other tool. After it completes, say DONE and stop.",
	);
	const transition = user.includes(
		"Use the bash tool to run exactly: printf 'tool-transition-test\\n'. Tell me the output.",
	);
	const question = user.includes(
		'Use the question tool exactly once, with one question: "Continue the contract test?", header "Contract", options [{"label":"Continue","description":"Finish this test"}], multiple false. You MUST invoke the question tool, do not ask in text. After I answer, say DONE and stop. Do not use any other tool.',
	);
	const attachment = user.includes("Reply with just the word 'ok'.");
	if (
		[permission, transition, question, attachment].filter(Boolean).length !== 1
	) {
		throw new Error(`Unsupported main prompt: ${user.slice(0, 512)}`);
	}
	const calls = request.messages
		.filter((message) => message.role === "assistant")
		.flatMap((message) => message.tool_calls ?? []);
	if (attachment) {
		if (
			calls.length ||
			!user.includes("Called the Read tool with the following input:") ||
			!user.includes("conduit-attachment-marker-7f3a\n")
		) {
			throw new Error(
				"Attachment request lacks native expanded text or has unexpected tools",
			);
		}
		return { content: "ok" };
	}
	const name = question ? "question" : "bash";
	const advertised = request.tools?.find(
		(tool) => tool.type === "function" && tool.function.name === name,
	);
	if (!advertised) throw new Error(`OpenCode did not advertise ${name}`);
	const properties = advertised.function.parameters.properties ?? {};
	const command = `printf '${permission ? "global-stream-contract" : "tool-transition-test"}\\n'`;
	const args: Record<string, unknown> = question
		? {
				questions: [
					{
						question: "Continue the contract test?",
						header: "Contract",
						options: [{ label: "Continue", description: "Finish this test" }],
						multiple: false,
					},
				],
			}
		: {
				command,
				...(properties["description"]
					? { description: "Run the contract printf" }
					: {}),
			};
	for (const key of advertised.function.parameters.required ?? []) {
		if (!(key in args))
			throw new Error(`Unsupported ${name} required argument ${key}`);
	}
	if (calls.length === 0) {
		return {
			content: null,
			tool_calls: [
				{
					id: `call_${randomUUID().replaceAll("-", "")}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		};
	}
	const call = calls[0];
	if (calls.length !== 1 || !call || call.function.name !== name) {
		throw new Error(
			"Expected exactly one matching tool call in the conversation",
		);
	}
	const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
	if (question) {
		const questions = input["questions"] as
			| {
					question: string;
					header: string;
					multiple: boolean;
					options: { label: string; description: string }[];
			  }[]
			| undefined;
		const first = questions?.[0];
		if (
			questions?.length !== 1 ||
			first?.question !== "Continue the contract test?" ||
			first.header !== "Contract" ||
			first.multiple !== false ||
			first.options.length !== 1 ||
			first.options[0]?.label !== "Continue" ||
			first.options[0]?.description !== "Finish this test"
		) {
			throw new Error("Question continuation changed the prescribed arguments");
		}
	} else if (input["command"] !== command) {
		throw new Error("Bash continuation changed the prescribed command");
	}
	const result = request.messages.find(
		(message) => message.role === "tool" && message.tool_call_id === call.id,
	);
	const expected = question
		? '"Continue the contract test?"="Continue"'
		: `${permission ? "global-stream-contract" : "tool-transition-test"}\n`;
	if (!result || !messageText(result).includes(expected)) {
		throw new Error(`Missing successful native tool result for ${call.id}`);
	}
	return { content: transition ? "tool-transition-test" : "DONE" };
}

export async function startControlledOpenCodeInference(evidencePath: string) {
	const requests: {
		receivedAt: number;
		method: string;
		url: string;
		request: string;
		requestBytes: number;
		response: string;
		status: number;
		error?: string;
	}[] = [];
	const errors: string[] = [];
	const sockets = new Set<Socket>();
	let configuration: string | undefined;
	let retainedBytes = 0;
	const recordError = (error: unknown) => {
		const message = String(error).slice(0, 2048);
		if (errors.length < 32) errors.push(message);
		return message;
	};
	const server = createServer(async (req, res) => {
		const proof = {
			receivedAt: Date.now(),
			method: req.method ?? "",
			url: req.url ?? "",
			request: "",
			requestBytes: 0,
			response: "",
			status: 0,
			error: "",
		};
		const chunks: Buffer[] = [];
		res.on("error", recordError);
		try {
			if (requests.length >= 64)
				throw new Error("Inference request count exceeded 64");
			requests.push(proof);
			if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
				throw new Error(`Unsupported inference route ${req.method} ${req.url}`);
			}
			for await (const chunk of req) {
				const bytes = Buffer.from(chunk as Uint8Array);
				proof.requestBytes += bytes.length;
				if (
					proof.requestBytes > 1024 * 1024 ||
					retainedBytes + bytes.length > 8 * 1024 * 1024
				) {
					throw new Error("Inference request/evidence byte limit exceeded");
				}
				chunks.push(bytes);
				retainedBytes += bytes.length;
			}
			proof.request = Buffer.concat(chunks).toString("utf8");
			const request = JSON.parse(proof.request) as ChatRequest;
			if (request.stream !== true)
				throw new Error("Expected the pinned OpenCode streaming request");
			const message = answer(request);
			const finish_reason = message.tool_calls ? "tool_calls" : "stop";
			const metadata = {
				id: `chatcmpl-${randomUUID()}`,
				created: Math.floor(Date.now() / 1000),
				model: request.model,
			};
			const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
			proof.status = 200;
			const delta = {
				role: "assistant",
				content: message.content,
				...(message.tool_calls
					? {
							tool_calls: message.tool_calls.map((call, index) => ({
								...call,
								index,
							})),
						}
					: {}),
			};
			proof.response = `${[
				{
					...metadata,
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta, finish_reason: null }],
				},
				{
					...metadata,
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: {}, finish_reason }],
					usage,
				},
			]
				.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
				.join("")}data: [DONE]\n\n`;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(proof.response);
		} catch (error) {
			proof.request = Buffer.concat(chunks).toString("utf8");
			proof.error = recordError(error);
			proof.status = 400;
			proof.response = JSON.stringify({
				error: {
					message: proof.error,
					type: "invalid_request_error",
					code: "controlled_inference",
				},
			});
			if (!res.headersSent && !res.destroyed)
				res.writeHead(400, { "Content-Type": "application/json" });
			if (!res.destroyed) res.end(proof.response);
		}
	});
	server.maxConnections = 16;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("error", recordError);
	const writeEvidence = () => {
		mkdirSync(dirname(evidencePath), { recursive: true });
		writeFileSync(
			evidencePath,
			JSON.stringify(
				{ configuration, requests, errors, retainedBytes },
				null,
				2,
			),
		);
	};
	let closing: Promise<void> | undefined;
	const close = () =>
		(closing ??= (async () => {
			try {
				writeEvidence();
			} finally {
				const closed = server.listening
					? new Promise<void>((resolve, reject) => {
							server.close((error) => (error ? reject(error) : resolve()));
						})
					: Promise.resolve();
				for (const socket of sockets) socket.destroy();
				await closed;
				writeEvidence();
			}
		})());
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing inference bind address");
		const model = {
			name: "Controlled contract inference",
			tool_call: true,
			limit: { context: 128_000, output: 4096 },
		};
		const provider = {
			npm: "@ai-sdk/openai-compatible",
			options: {
				baseURL: `http://127.0.0.1:${address.port}/v1`,
				apiKey: "controlled-local-only",
			},
			models: { main: model, auxiliary: { ...model, tool_call: false } },
		};
		const config = {
			model: CONTROLLED_MODEL_ID,
			small_model: AUXILIARY_MODEL_ID,
			enabled_providers: [CONTROLLED_MODEL.providerID],
			agent: {
				build: { model: CONTROLLED_MODEL_ID },
				plan: { model: CONTROLLED_MODEL_ID },
				general: { model: CONTROLLED_MODEL_ID },
				explore: { model: CONTROLLED_MODEL_ID },
				// Model-only overrides serialize missing native descriptions as null.
				title: {
					model: AUXILIARY_MODEL_ID,
					description: "Name the contract conversation",
				},
				summary: {
					model: AUXILIARY_MODEL_ID,
					description: "Summarize the contract conversation",
				},
				compaction: {
					model: AUXILIARY_MODEL_ID,
					description: "Compact the contract conversation",
				},
			},
			provider: { [CONTROLLED_MODEL.providerID]: provider },
		};
		const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
		const assertOpenCodeConfig = async (url: string) => {
			try {
				const res = await fetch(`${url}/config`, {
					signal: AbortSignal.timeout(5_000),
				});
				if (!res.ok) throw new Error(`Native config GET failed: ${res.status}`);
				const actual = (await res.json()) as typeof config;
				const actualProvider = actual.provider?.[CONTROLLED_MODEL.providerID];
				configuration = JSON.stringify({
					model: actual.model,
					small_model: actual.small_model,
					enabled_providers: actual.enabled_providers,
					npm: actualProvider?.npm,
					baseURL: actualProvider?.options?.baseURL,
					agents: Object.fromEntries(
						Object.keys(config.agent).map((key) => [
							key,
							actual.agent?.[key as keyof typeof config.agent]?.model,
						]),
					),
				}).slice(0, 65536);
				if (
					actual.model !== config.model ||
					actual.small_model !== config.small_model ||
					JSON.stringify(actual.enabled_providers) !==
						JSON.stringify(config.enabled_providers) ||
					actualProvider?.npm !== provider.npm ||
					actualProvider?.options?.baseURL !== provider.options.baseURL ||
					Object.keys(config.agent).some(
						(key) =>
							actual.agent?.[key as keyof typeof config.agent]?.model !==
							config.agent[key as keyof typeof config.agent].model,
					)
				) {
					throw new Error(
						"Native OpenCode config does not route all fixture models to loopback",
					);
				}
			} catch (error) {
				recordError(error);
				throw error;
			}
		};
		return {
			env,
			requests,
			errors,
			writeEvidence,
			assertOpenCodeConfig,
			close,
		};
	} catch (error) {
		recordError(error);
		await close();
		throw error;
	}
}
