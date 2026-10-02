import type { GetSessionSkillsResponse } from "../contracts/ws-rpc.js";
import type { MessageWithParts } from "../persistence/read-model-types.js";
import { normalizeToolInput } from "../provider/opencode/normalize-tool-input.js";
import { skillNameFromTool, tokenizeSkills } from "../skill-recognition.js";

export type SessionSkillLoad = GetSessionSkillsResponse["loads"][number];

export function collectSessionSkillLoads(
	messages: readonly MessageWithParts[],
	skillNames: ReadonlySet<string>,
): SessionSkillLoad[] {
	const loads: SessionSkillLoad[] = [];
	let userMessages = 0;
	for (const message of messages) {
		if (message.role === "user") {
			userMessages += 1;
			const match = message.text.match(
				/<user-message>\n([\s\S]*?)\n<\/user-message>/,
			);
			const text = match?.[1] ?? message.text;
			for (const segment of tokenizeSkills(text, skillNames)) {
				if (segment.kind !== "skill") continue;
				loads.push({
					name: segment.text.slice(1),
					invokedBy: "user",
					turnOrdinal: userMessages,
					at: message.created_at,
					anchor: { messageId: message.id },
					running: false,
				});
			}
		}
		for (const part of message.parts) {
			if (part.type !== "tool") continue;
			let input: unknown;
			try {
				input = JSON.parse(part.input ?? "null") ?? undefined;
			} catch {
				input = undefined;
			}
			const canonical =
				input !== null &&
				typeof input === "object" &&
				"tool" in input &&
				typeof input.tool === "string"
					? input
					: normalizeToolInput(part.tool_name ?? "", input);
			const name = skillNameFromTool(canonical, part.result ?? undefined);
			if (!name) continue;
			loads.push({
				name,
				invokedBy: "agent",
				turnOrdinal: Math.max(1, userMessages),
				at: part.created_at,
				anchor: { messageId: part.message_id, partId: part.id },
				running: part.status === "pending" || part.status === "running",
			});
		}
	}
	return loads;
}
