import { Data } from "effect";
import {
	decodeClaudeSDKMessage,
	decodeClaudeSDKOptionsJsonShape,
	decodeClaudeSDKUserMessage,
} from "../../contracts/providers/claude-agent-sdk.js";
import { createLogger } from "../../logger.js";
import type {
	SDKMessage,
	Options as SDKOptions,
	SDKUserMessage,
} from "./types.js";

const log = createLogger("claude-provider-runtime");
const MAX_DECODE_ERROR_LENGTH = 800;
const MAX_DECODE_PAYLOAD_LOG_LENGTH = 1200;

export function asError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function truncateForProviderError(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function decodeFailureMessage(boundary: string, cause: unknown): string {
	const details = truncateForProviderError(
		cause instanceof Error ? cause.message : String(cause),
		MAX_DECODE_ERROR_LENGTH,
	);
	return `${boundary} decode failed: ${details}`;
}

export class ClaudeSDKDecodeError extends Data.TaggedError(
	"ClaudeSDKDecodeError",
)<{
	readonly boundary: string;
	readonly cause: unknown;
}> {
	override get message(): string {
		return decodeFailureMessage(this.boundary, this.cause);
	}
}

function logDecodeFailure(
	boundary: string,
	cause: unknown,
	payload: unknown,
): void {
	log.warn(
		`${decodeFailureMessage(boundary, cause)}; payload=${truncateForProviderError(
			safeStringify(payload),
			MAX_DECODE_PAYLOAD_LOG_LENGTH,
		)}`,
	);
}

export function decodeProviderMessage(message: unknown): SDKMessage {
	try {
		return decodeClaudeSDKMessage(message);
	} catch (cause) {
		logDecodeFailure("Claude SDK message", cause, message);
		throw new ClaudeSDKDecodeError({ boundary: "Claude SDK message", cause });
	}
}

export function validateUserMessage(message: SDKUserMessage): SDKUserMessage {
	try {
		return decodeClaudeSDKUserMessage(message);
	} catch (cause) {
		logDecodeFailure("Claude SDK user message", cause, message);
		throw new ClaudeSDKDecodeError({
			boundary: "Claude SDK user message",
			cause,
		});
	}
}

export function validateOptionsJsonShape(options: SDKOptions): SDKOptions {
	try {
		return decodeClaudeSDKOptionsJsonShape(options);
	} catch (cause) {
		logDecodeFailure("Claude SDK options", cause, options);
		throw new ClaudeSDKDecodeError({ boundary: "Claude SDK options", cause });
	}
}
