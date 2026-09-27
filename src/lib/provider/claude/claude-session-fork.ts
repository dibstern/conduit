import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

interface SdkCallOptions {
	readonly dir: string;
	readonly configDir?: string;
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

// The SDK's session functions find transcripts via process.env.CLAUDE_CONFIG_DIR
// at call time and take no option for it. Setting it on the daemon would leak
// into every process spawned meanwhile (Claude queries, terminals, OpenCode),
// so each call runs in a worker with its own env.
//
// Transcripts are read with importSessionToStore, not getSessionMessages: the
// latter returns only the chain after the latest compaction, so earlier turns
// would be unforkable. forkSession accepts those uuids and copies the
// uncompacted history up to them.
const SDK_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { sdkUrl, op, sessionId, options } = workerData;
import(sdkUrl)
	.then(async (sdk) => {
		if (op === "forkSession") return sdk.forkSession(sessionId, options);
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

function runSdkInWorker<T>(
	op: "readTranscript" | "forkSession",
	sessionId: string,
	{
		configDir,
		...options
	}: SdkCallOptions & { title?: string; upToMessageId?: string },
): Promise<T> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(SDK_WORKER_SOURCE, {
			eval: true,
			...(configDir !== undefined && {
				env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
			}),
			workerData: {
				sdkUrl: pathToFileURL(
					createRequire(import.meta.url).resolve(
						"@anthropic-ai/claude-agent-sdk",
					),
				).href,
				op,
				sessionId,
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
			{ type: string; isSidechain?: boolean }[]
		>("readTranscript", sessionId, options);
		return entries.filter(
			(entry) =>
				(entry.type === "user" || entry.type === "assistant") &&
				entry.isSidechain !== true,
		) as unknown as SessionMessage[];
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

export async function forkClaudeTranscript(
	input: {
		readonly parentSdkId: string;
		readonly projectDir: string;
		readonly configDir?: string;
		readonly title: string;
		readonly messageId?: string;
	},
	sdk: ClaudeSessionForkSdk = defaultClaudeSessionForkSdk,
): Promise<{ sdkSessionId: string }> {
	const options = {
		dir: input.projectDir,
		...(input.configDir !== undefined && { configDir: input.configDir }),
	};
	let upToMessageId: string | undefined;
	if (input.messageId !== undefined) {
		const parentMessages = await sdk.readTranscript(input.parentSdkId, options);
		upToMessageId = resolveForkUpToUuid(parentMessages, input.messageId);
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
