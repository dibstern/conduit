import { Schema } from "effect";
import {
	canonicalEvent,
	EventId,
	type StoredEvent,
} from "../../src/lib/persistence/events.js";

// Historical payloads deliberately omit `by`. Reuse this log when changing
// Limit Recovery projection so old histories keep rebuilding identically.
export const resumeLegacyTags: readonly StoredEvent[] = [
	{ id: "policy", tags: ["limit-policy"], cutOff: true },
	{
		id: "sweep-policy",
		tags: ["limit-policy", "continuation-sweep"],
		cutOff: true,
	},
	{ id: "sweep-user", tags: ["continuation-sweep"], cutOff: true },
	{ id: "user-tag", tags: ["limit-policy", "browser"], cutOff: true },
	{ id: "user-untagged", tags: ["limit-policy", undefined], cutOff: true },
	{ id: "inbox-reset", tags: ["limit-policy"], cutOff: false },
	{ id: "inbox-reset-cut-off", tags: ["limit-policy"], cutOff: true },
]
	.flatMap(({ id, tags, cutOff }) =>
		[
			canonicalEvent("session.created", id, {
				sessionId: id,
				title: id,
				provider: "claude",
			}),
			canonicalEvent("session.usage_limited", id, {
				instanceId: "claude",
				rateLimitType: "seven_day",
				resetsAt: 1791234000,
				cutOffMessageId: `cut-off-${id}`,
			}),
			...(cutOff
				? []
				: [
						canonicalEvent("session.cut_off_dismissed", id, {
							cutOffMessageId: `cut-off-${id}`,
						}),
					]),
			...tags.map((source, index) =>
				canonicalEvent(
					"session.resume_scheduled",
					id,
					{ instanceId: "claude", at: 1791234000 + index * 300 },
					{ metadata: source === undefined ? {} : { source } },
				),
			),
			...(id.startsWith("inbox-reset")
				? [
						canonicalEvent(
							"session.resume_cancelled",
							id,
							{},
							{
								metadata: { source: "inbox-reset" },
							},
						),
					]
				: []),
		].map((event, index) => ({ ...event, streamVersion: index + 1 })),
	)
	.map((event, index) => ({
		...event,
		eventId: Schema.decodeSync(EventId)(`resume-legacy-tags-${index + 1}`),
		projectId: "test-project",
		provider: "claude",
		sequence: index + 1,
		createdAt: 1791230000000 + index,
	}));
