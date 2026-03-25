import { describe, expect, it } from "vitest";
import { createTranslator } from "../../../src/lib/relay/event-translator.js";
import type { KnownOpenCodeEventType } from "../../../src/lib/relay/opencode-events.js";

const KNOWN_EVENT_TYPES: KnownOpenCodeEventType[] = [
	"message.part.delta",
	"message.part.updated",
	"message.part.removed",
	"message.created",
	"message.updated",
	"message.removed",
	"session.status",
	"session.error",
	"permission.asked",
	"permission.replied",
	"question.asked",
	"pty.created",
	"pty.exited",
	"pty.deleted",
	"file.edited",
	"file.watcher.updated",
	"installation.update-available",
	"todo.updated",
];

describe("Event Type Safety", () => {
	it("translator handles or explicitly skips every known event type", () => {
		const translator = createTranslator();
		for (const eventType of KNOWN_EVENT_TYPES) {
			const result = translator.translate({ type: eventType, properties: {} });
			if (!result.ok) {
				expect(result.reason, `"${eventType}" returned unhandled`).not.toMatch(
					/^unhandled event type/,
				);
			}
		}
	});

	it("unknown event types fall through to catch-all", () => {
		const translator = createTranslator();
		const result = translator.translate({
			type: "future.unknown",
			properties: {},
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("unhandled event type");
	});
});
