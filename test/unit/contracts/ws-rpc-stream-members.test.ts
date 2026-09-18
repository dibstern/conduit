import { RpcSchema } from "@effect/rpc";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Contracts from "../../../src/lib/contracts/ws-rpc.js";
import * as Frontend from "../../../src/lib/frontend/transport/ws-rpc.js";

describe("subscription RPC contracts", () => {
	it("exposes a resumable detail stream requiring a session and yielding detail envelopes", () => {
		const member = Contracts.SubscribeSessionDetail;
		expect(member).toBeDefined();
		expect(Contracts.WsRpcGroup.requests.get("SubscribeSessionDetail")).toBe(
			member,
		);
		expect(Frontend.SubscribeSessionDetail).toBe(member);
		const decodePayload = Schema.decodeUnknownSync(member.payloadSchema);
		for (const payload of [
			{ projectSlug: "project", sessionId: "session-1" },
			{
				projectSlug: "project",
				sessionId: "session-1",
				resumeFromSequence: 42,
			},
		]) {
			expect(decodePayload(payload)).toEqual(payload);
		}
		for (const payload of [
			{ projectSlug: "project" },
			{ projectSlug: "project", sessionId: "" },
			{
				projectSlug: "project",
				sessionId: "session-1",
				resumeFromSequence: "42",
			},
		]) {
			expect(() => decodePayload(payload)).toThrow();
		}
		expect(RpcSchema.isStreamSchema(member.successSchema)).toBe(true);
		expect(member.successSchema.failure).toBe(Contracts.WsRpcError);
		const decode = Schema.decodeUnknownSync(member.successSchema.success);
		const message = {
			_tag: "transcriptMessage",
			message: { id: "message-1", role: "assistant" },
		};
		const event = {
			_tag: "event",
			event: {
				eventId: "event-1",
				sessionId: "session-1",
				type: "text.delta",
				data: { messageId: "message-1", partId: "part-1", text: "Hello" },
				metadata: {},
				provider: "claude",
				createdAt: 100,
				sequence: 43,
				streamVersion: 1,
			},
		};
		for (const envelope of [
			{ _tag: "snapshot", rows: [message, event], sequence: 43 },
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: message, sequence: 44 },
			{ _tag: "upsert", item: event, sequence: 45 },
			{ _tag: "remove", id: "message-1", sequence: 46 },
		]) {
			expect(decode(envelope)).toEqual(envelope);
		}
		for (const invalid of [
			message,
			{ _tag: "upsert", item: [message], sequence: 44 },
			{ _tag: "upsert", item: message },
			{ _tag: "snapshot", rows: [{ _tag: "event", event: {} }], sequence: 43 },
		]) {
			expect(() => decode(invalid)).toThrow();
		}
	});

	it("exposes a resumable shell stream of session envelopes through the frontend", () => {
		const member = Contracts.SubscribeShell;
		expect(member).toBeDefined();
		expect(Contracts.WsRpcGroup.requests.get("SubscribeShell")).toBe(member);
		expect(Frontend.SubscribeShell).toBe(member);
		const decodePayload = Schema.decodeUnknownSync(member.payloadSchema);
		for (const payload of [
			{ projectSlug: "project" },
			{ projectSlug: "project", resumeFromSequence: 42 },
		]) {
			expect(decodePayload(payload)).toEqual(payload);
		}
		expect(() =>
			decodePayload({ projectSlug: "project", resumeFromSequence: "42" }),
		).toThrow();
		expect(RpcSchema.isStreamSchema(member.successSchema)).toBe(true);
		expect(member.successSchema.failure).toBe(Contracts.WsRpcError);
		const decode = Schema.decodeUnknownSync(member.successSchema.success);
		const session = { id: "session-1", title: "Session", status: "idle" };
		for (const envelope of [
			{ _tag: "snapshot", rows: [session], sequence: 42 },
			{ _tag: "synchronized" },
			{ _tag: "upsert", item: session, sequence: 43 },
			{ _tag: "remove", id: "session-1", sequence: 44 },
		]) {
			expect(decode(envelope)).toEqual(envelope);
		}
		expect(() => decode(session)).toThrow();
		expect(() => decode({ _tag: "upsert", item: session })).toThrow();
		expect(() =>
			decode({ _tag: "snapshot", rows: [{ id: "session-1" }], sequence: 42 }),
		).toThrow();
	});
});
