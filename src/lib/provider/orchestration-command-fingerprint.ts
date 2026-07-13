// src/lib/provider/orchestration-command-fingerprint.ts
// ─── Effective Dispatch Fingerprint ─────────────────────────────────────────
// Pure canonicalizer for the durable command fingerprint. It derives the
// *effective* provider dispatch request (provider instance, selected model
// after provider-specific derivations, normalized+sorted options, prompt, image
// digests, execution cwd/worktree) and hashes it deterministically. Runtime
// handles (eventSink, AbortSignal, callbacks) are never included.

import { createHash } from "node:crypto";
import { claudeApiModelId } from "./claude/claude-api-model-id.js";
import {
	DURABLE_COMMAND_FINGERPRINT_VERSION,
	type DurableCommandFingerprint,
	type DurableCommandFingerprintField,
} from "./orchestration-command-contracts.js";
import type { SendTurnCommand } from "./orchestration-engine.js";

export interface EffectiveDispatchFingerprintOptions {
	/**
	 * The session's active model, used as the Claude fallback when the command
	 * omits an explicit model selection (mirrors the runtime's
	 * `input.model?.modelId ?? ctx.currentModel`). Absent for a fresh session or
	 * when the caller cannot resolve it.
	 */
	readonly activeSessionModelId?: string;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Drop `undefined` values and sort keys for a stable option record. */
function normalizeOptions(
	options: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(options).sort()) {
		const value = options[key];
		if (value !== undefined) normalized[key] = value;
	}
	return normalized;
}

/**
 * Selected model after provider-specific derivation.
 *
 * - Claude: the context-window option folds into the API model id suffix (e.g.
 *   `sonnet[1m]`) only when the model supports it, so raw contextWindow is not
 *   fingerprinted separately. When the command omits a model, the effective
 *   model is the active-session model fallback (mirroring the runtime's
 *   `input.model?.modelId ?? ctx.currentModel`).
 * - OpenCode: dispatch sends the `{providerId, modelId}` pair, so the model
 *   provider is part of the effective model identity — a different model
 *   provider with the same model id is a materially different dispatch.
 */
function effectiveModel(
	command: SendTurnCommand,
	options: EffectiveDispatchFingerprintOptions,
): unknown {
	const { providerId, input } = command;
	if (providerId === "claude") {
		const modelId = input.model?.modelId ?? options.activeSessionModelId;
		return claudeApiModelId(modelId, input.contextWindow) ?? null;
	}
	if (!input.model) return null;
	return { providerId: input.model.providerId, modelId: input.model.modelId };
}

export function effectiveDispatchFingerprint(
	command: SendTurnCommand,
	options: EffectiveDispatchFingerprintOptions = {},
): DurableCommandFingerprint {
	const { providerId, input } = command;
	const providerOptions = normalizeOptions({
		variant: input.variant,
		agent: input.agent,
		// contextWindow folds into effectiveModel for Claude; keep it as a raw
		// option for providers that treat it independently.
		...(providerId === "claude" ? {} : { contextWindow: input.contextWindow }),
	});
	const fields: Record<DurableCommandFingerprintField, unknown> = {
		commandType: "send_turn",
		sessionId: input.sessionId,
		providerId,
		providerInstanceId: providerId,
		runtimeMode: null,
		interactionMode: null,
		workspaceRoot: input.workspaceRoot,
		promptText: input.prompt,
		imageDigests: (input.images ?? []).map(sha256Hex),
		effectiveModel: effectiveModel(command, options),
		providerOptions,
		materialDefaults: null,
	};
	return { version: DURABLE_COMMAND_FINGERPRINT_VERSION, fields };
}

/** Canonical JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	const entries = Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
	return `{${entries.join(",")}}`;
}

export function fingerprintHash(
	fingerprint: DurableCommandFingerprint,
): string {
	return `sha256:${sha256Hex(canonicalJson(fingerprint))}`;
}
