// One session type on the wire (ni8.5 T-1). The read-model row, the camelCase
// wire struct and the hand-written bridge between them collapsed into this
// single schema, so these assertions are the whole contract every session
// consumer — server handler, subscription and store — now compiles against.

import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { SessionInfoSchema } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type RelayMessage,
	type SessionInfo,
	SessionInfoSchema as SharedSessionInfoSchema,
} from "../../../src/lib/shared-types.js";

describe("session wire type", () => {
	it("is one declaration, not a contracts copy of a shared-types copy", () => {
		expect(SessionInfoSchema).toBe(SharedSessionInfoSchema);
	});

	it("carries the row's status and survives a JSON round trip", () => {
		const session: SessionInfo = {
			id: "ses_1",
			title: "Fix the sidebar",
			status: "busy",
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_001_000,
			messageCount: 0,
			parentID: "ses_0",
			forkMessageId: "msg_9",
			forkPointTimestamp: 1_699_999_000_000,
		};
		const encoded = Schema.encodeSync(SessionInfoSchema)(session);
		expect(JSON.parse(JSON.stringify(encoded))).toEqual(session);
		expect(Schema.decodeUnknownSync(SessionInfoSchema)(encoded)).toEqual(
			session,
		);
	});

	it("rejects a status the sessions projection cannot produce", () => {
		expect(() =>
			Schema.decodeUnknownSync(SessionInfoSchema)({
				id: "ses_1",
				title: "t",
				status: "processing",
			}),
		).toThrow();
	});

	it("does not carry notification state or the poller's derived flag", () => {
		expectTypeOf<SessionInfo>().not.toHaveProperty("pendingQuestionCount");
		expectTypeOf<SessionInfo>().not.toHaveProperty("processing");
	});

	it("carries the three notification facts on the row itself (ni8.23)", () => {
		// The badge is derived server-side from pending_approvals and
		// last_viewed_at, so it travels on the session it describes.
		const derived: SessionInfo = {
			id: "ses_1",
			title: "t",
			status: "idle",
			pendingQuestions: 2,
			pendingPermissions: 1,
			unseenActivity: true,
		};
		const encoded = Schema.encodeSync(SessionInfoSchema)(derived);
		expect(Schema.decodeUnknownSync(SessionInfoSchema)(encoded)).toEqual(
			derived,
		);
	});

	it("ships no notification side-channel beside the sessions (ni8.23)", () => {
		// ni8.5 §5 put pending question counts in a map beside the list because
		// no session row could carry them. One of them is now a column, and two
		// sources for one fact is how a badge starts disagreeing with itself.
		expectTypeOf<
			Extract<RelayMessage, { type: "session_list" }>
		>().not.toHaveProperty("pendingQuestionCounts");
	});
});
