import { createHash } from "node:crypto";
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type { MessageSnapshotPayload } from "../../contracts/stored-event.js";
import type { Message } from "../../instance/sdk-types.js";
import { mapToolName } from "../../relay/event-translator.js";
import { normalizeToolInput } from "./normalize-tool-input.js";

export function isSettled(message: Message | undefined): boolean {
	if (!message) return false;
	return message.role === "user"
		? (message.parts?.length ?? 0) > 0
		: message.time?.completed != null;
}

/** Stable across REST object key order, while keeping part order significant. */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) => {
		if (item === null || typeof item !== "object" || Array.isArray(item))
			return item;
		return Object.fromEntries(
			Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
		);
	});
}

export function snapshotPayload(message: Message): MessageSnapshotPayload {
	const parts = (message.parts ?? []).map((part) => {
		if (part.type !== "tool") return part;
		const state = part["state"];
		if (typeof state !== "object" || state === null || Array.isArray(state))
			return part;
		const tool =
			typeof part["tool"] === "string" ? mapToolName(part["tool"]) : "";
		return {
			...part,
			state: {
				...state,
				input: normalizeToolInput(
					tool,
					"input" in state ? state.input : undefined,
				),
			},
		};
	});
	const normalized = { ...message, parts };
	const digest = createHash("sha256")
		.update(stableJson(normalized))
		.digest("hex");
	return { messageId: message.id, digest, message: normalized };
}

/** A changed REST message gets a new event; identical content collides by id. */
export function synthesizeSnapshotEvent(
	sessionId: string,
	message: Message,
	supersedesEventId?: string,
): ProviderRuntimeEvent {
	const data = {
		...snapshotPayload(message),
		...(supersedesEventId ? { supersedesEventId } : {}),
	};
	const eventDigest = createHash("sha256")
		.update(stableJson(data))
		.digest("hex");
	return {
		eventId: `evt_opencode_snapshot_${message.id}_${eventDigest}`,
		type: "message.snapshot",
		providerId: "opencode",
		sessionId,
		providerRefs: { providerMessageId: message.id },
		rawSource: { kind: "opencode.rest", endpoint: "session.messages" },
		createdAt: message.time?.completed ?? message.time?.created ?? Date.now(),
		data,
	};
}
