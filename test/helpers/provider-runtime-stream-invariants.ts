import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../src/lib/contracts/providers/provider-runtime-event.js";

// Structural invariants every provider-translator output stream must satisfy,
// regardless of scenario. Born from the 2026-07-15 incident where a text
// block's content_block_stop emitted tool.completed carrying the part's own
// uuid as messageId — the ingress pipeline expanded it into a phantom
// "Unknown" tool and a phantom empty assistant message. Scenario tests assert
// what SHOULD happen; this asserts what must NEVER happen. Call it on the
// sink's collected events at the end of every translator test (afterEach).

const MESSAGE_SCOPED_TYPES = new Set([
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
]);

export function assertProviderRuntimeStreamInvariants(
	events: ReadonlyArray<ProviderRuntimeEvent>,
	options: {
		/** Tool partIds whose tool.started legitimately happened before the
		 *  observed window (tests that open mid-turn with seeded state). */
		readonly preStartedToolPartIds?: Iterable<string>;
	} = {},
): void {
	const announcedMessageIds = new Set<string>();
	const startedToolPartIds = new Set<string>(
		options.preStartedToolPartIds ?? [],
	);
	const completedToolPartIds = new Set<string>();

	events.forEach((event, index) => {
		// Explicit annotation so control-flow analysis treats calls as
		// unreachable-terminating (narrows the checked fields after a guard).
		const fail: (reason: string) => never = (reason) => {
			throw new Error(
				`stream invariant violated at event[${index}] (${event.type}): ${reason}\n${JSON.stringify(event, null, 1)}`,
			);
		};

		try {
			decodeProviderRuntimeEvent(event);
		} catch (cause) {
			fail(`envelope failed schema decode: ${String(cause)}`);
		}

		const data =
			typeof event.data === "object" && event.data !== null
				? (event.data as Record<string, unknown>)
				: {};
		const messageId =
			typeof data["messageId"] === "string" ? data["messageId"] : undefined;
		const partId =
			typeof data["partId"] === "string" ? data["partId"] : undefined;

		if (event.type === "message.created") {
			if (messageId === undefined || messageId.length === 0) {
				fail("message.created without a messageId");
			}
			announcedMessageIds.add(messageId);
			return;
		}

		// Content events must attribute to an announced assistant message —
		// never to a self-minted id (the phantom-message bug). Tool and turn
		// events may legitimately fall back to lastAssistantUuid, so only
		// message-scoped content types are held to announcement.
		if (
			MESSAGE_SCOPED_TYPES.has(event.type) &&
			messageId !== undefined &&
			messageId.length > 0 &&
			!announcedMessageIds.has(messageId)
		) {
			fail(`references unannounced messageId "${messageId}"`);
		}

		if (event.type === "tool.started") {
			if (partId === undefined || partId.length === 0) {
				fail("tool.started without a partId");
			}
			startedToolPartIds.add(partId);
			return;
		}

		// Orphan tool.running is tolerated: SDK task_progress for a parent
		// tool can arrive before/without its tool_use block in this stream,
		// and the ingress mapper handles it. Orphan tool.completed is NOT —
		// the mapper launders it into a synthetic "Unknown" tool.started,
		// which is exactly how the phantom tool card rendered.
		if (event.type === "tool.completed") {
			if (partId === undefined || partId.length === 0) {
				fail("tool.completed without a partId");
				return;
			}
			if (!startedToolPartIds.has(partId)) {
				fail(`orphan tool.completed for partId "${partId}" — no tool.started`);
			}
			if (completedToolPartIds.has(partId)) {
				fail(`duplicate tool.completed for partId "${partId}"`);
			}
			completedToolPartIds.add(partId);
		}
	});
}
