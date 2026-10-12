import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntimeError } from "../event-sink-errors.js";
import {
	type ClaudeConfigDir,
	configuredClaudeConfigDir,
	makeClaudeSdkEnv,
} from "./claude-sdk-env.js";

interface SdkCallOptions {
	readonly dir?: string;
	readonly configDir: ClaudeConfigDir;
}

export interface ClaudeSessionForkSdk {
	/** Every main-conversation entry in the transcript, in file order. */
	readTranscript(
		sessionId: string,
		options: SdkCallOptions,
	): Promise<SessionMessage[]>;
	forkSession(
		sessionId: string,
		options: SdkCallOptions & { title: string; upToMessageId?: string },
	): Promise<{ sessionId: string }>;
}

// The SDK's session functions choose their transcript root from their process
// environment, rather than a per-call option. Each call runs in a worker so
// account selection cannot leak into Claude queries, terminals, or OpenCode.
//
// Transcripts are read with importSessionToStore, not getSessionMessages: the
// latter returns only the chain after the latest compaction, so earlier turns
// would be unforkable. forkSession accepts those uuids and copies the
// uncompacted history up to them.
const SDK_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { sdkUrl, op, sessionId, sdkSubagentId, options } = workerData;
import(sdkUrl)
	.then(async (sdk) => {
		if (op === "forkSession") return sdk.forkSession(sessionId, options);
		if (op === "listSubagents") return sdk.listSubagents(sessionId, options);
		if (op === "getSubagentMessages") {
			return sdk.getSubagentMessages(sessionId, sdkSubagentId, options);
		}
		const entries = [];
		await sdk.importSessionToStore(
			sessionId,
			{
				append: async (key, batch) => {
					if (key.subpath === undefined) entries.push(...batch);
				},
				load: async () => null,
			},
			{ dir: options.dir, includeSubagents: false },
		);
		return entries;
	})
	.then(
		(result) => parentPort.postMessage({ result }),
		(error) => parentPort.postMessage({ error: String(error?.message ?? error) }),
	);
`;

export function runSdkInWorker<T>(
	op:
		| "readTranscript"
		| "forkSession"
		| "listSubagents"
		| "getSubagentMessages",
	sessionId: string,
	{
		configDir,
		...options
	}: SdkCallOptions & { title?: string; upToMessageId?: string },
	sdkSubagentId?: string,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(SDK_WORKER_SOURCE, {
			eval: true,
			// Native os.homedir() ignores a worker's private HOME. These SDK calls
			// only access transcript files, so give them the resolved root explicitly.
			env: makeClaudeSdkEnv({
				configDir:
					configDir?._tag === "SdkDefault"
						? configuredClaudeConfigDir(configDir.path)
						: configDir,
			}),
			workerData: {
				sdkUrl: pathToFileURL(
					createRequire(import.meta.url).resolve(
						"@anthropic-ai/claude-agent-sdk",
					),
				).href,
				op,
				sessionId,
				sdkSubagentId,
				options,
			},
		});
		worker.once("message", (message: { result?: T; error?: string }) => {
			if (message.error !== undefined) reject(new Error(message.error));
			else resolve(message.result as T);
			void worker.terminate();
		});
		worker.once("error", reject);
		worker.once("exit", (code) =>
			reject(new Error(`Claude SDK worker exited with code ${code}`)),
		);
	});
}

export const defaultClaudeSessionForkSdk: ClaudeSessionForkSdk = {
	readTranscript: async (sessionId, options) => {
		const entries = await runSdkInWorker<
			Array<SessionMessage & { readonly isSidechain?: boolean }>
		>("readTranscript", sessionId, options);
		return entries.filter(
			(entry) =>
				(entry.type === "user" || entry.type === "assistant") &&
				entry.isSidechain !== true,
		);
	},
	forkSession: (sessionId, options) =>
		runSdkInWorker("forkSession", sessionId, options),
};

class ClaudeForkPointNotFoundError extends Error {
	constructor(messageId: string) {
		super(`Fork point ${messageId} was not found in the Claude transcript`);
		this.name = "ClaudeForkPointNotFoundError";
	}
}

function isRealUserPrompt(entry: SessionMessage): boolean {
	if (entry.type !== "user") return false;
	const message = entry.message;
	if (
		typeof message !== "object" ||
		message === null ||
		!("content" in message)
	)
		return false;
	const content = message.content;
	return (
		typeof content === "string" ||
		(Array.isArray(content) &&
			content.some(
				(block) =>
					typeof block !== "object" ||
					block === null ||
					!("type" in block) ||
					block.type !== "tool_result",
			))
	);
}

export function resolveForkUpToUuid(
	messages: readonly SessionMessage[],
	messageId: string,
): string | undefined {
	const start = messages.findIndex((entry) => {
		const message = entry.message;
		return (
			message !== null &&
			typeof message === "object" &&
			"id" in message &&
			message.id === messageId
		);
	});
	if (start < 0) return undefined;
	let end = start;
	for (let index = start + 1; index < messages.length; index++) {
		const entry = messages[index];
		if (entry && isRealUserPrompt(entry)) break;
		end = index;
	}
	return messages[end]?.uuid;
}

/** Rewind excludes its target, including cuts inside an assistant turn. */
export function resolveRewindUpToUuid(
	messages: readonly SessionMessage[],
	messageId: string,
	targetMessageId?: string,
): string | null | undefined {
	const matches = (entry: SessionMessage, id: string): boolean => {
		const message = entry.message;
		return (
			entry.uuid === id ||
			(message !== null &&
				typeof message === "object" &&
				"id" in message &&
				message.id === id)
		);
	};
	if (targetMessageId === undefined)
		return (
			resolveForkUpToUuid(messages, messageId) ??
			messages.find((entry) => matches(entry, messageId))?.uuid
		);
	const targetIndex = messages.findIndex((entry) =>
		matches(entry, targetMessageId),
	);
	if (
		targetIndex < 0 ||
		!messages.slice(0, targetIndex).some((entry) => matches(entry, messageId))
	)
		return undefined;
	const target = messages[targetIndex];
	// Imported SDK entries retain the native chain link. File-order adjacency
	// can refer to an abandoned branch after an earlier in-place rewind.
	if (target && "parentUuid" in target) {
		if (typeof target.parentUuid === "string") return target.parentUuid;
		if (target.parentUuid === null) return undefined;
	}
	return messages[targetIndex - 1]?.uuid ?? null;
}

export async function forkClaudeTranscript(
	input: {
		readonly parentSdkId: string;
		readonly projectDir?: string;
		readonly configDir: ClaudeConfigDir;
		readonly title: string;
		readonly messageId?: string;
		readonly fallbackMessageIds?: readonly string[];
	},
	sdk: ClaudeSessionForkSdk,
): Promise<{ sdkSessionId: string }> {
	if (
		typeof input.configDir?.path !== "string" ||
		input.configDir.path.trim().length === 0
	)
		throw new ClaudeRuntimeError({
			message: "Claude config directory must be non-empty",
		});
	const options = {
		...(input.projectDir !== undefined && { dir: input.projectDir }),
		configDir: input.configDir,
	};
	let upToMessageId: string | undefined;
	if (input.messageId !== undefined) {
		const parentMessages = await sdk.readTranscript(input.parentSdkId, options);
		upToMessageId = resolveForkUpToUuid(parentMessages, input.messageId);
		for (const fallbackMessageId of input.fallbackMessageIds ?? []) {
			if (upToMessageId !== undefined) break;
			upToMessageId = resolveForkUpToUuid(parentMessages, fallbackMessageId);
		}
		if (upToMessageId === undefined) {
			throw new ClaudeForkPointNotFoundError(input.messageId);
		}
	}
	const { sessionId } = await sdk.forkSession(input.parentSdkId, {
		...options,
		title: input.title,
		...(upToMessageId !== undefined && { upToMessageId }),
	});
	return { sdkSessionId: sessionId };
}
