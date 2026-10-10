import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockMessage } from "../../e2e/fixtures/mockup-state.js";
import {
	type RpcMockControl,
	sendMockProjectSetting,
} from "../../e2e/helpers/rpc-mock.js";
import {
	createMockRelayProtocolContext,
	normalizeMockRelayMessage,
	normalizeMockRelayMessages,
	WsMockControl,
} from "../../e2e/helpers/ws-mock.js";

vi.mock("../../e2e/helpers/rpc-mock.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../e2e/helpers/rpc-mock.js")>()),
	sendMockProjectSetting: vi.fn(),
}));

describe("E2E WebSocket mock protocol normalizer", () => {
	it("adds sessionId to session-scoped init and live messages", () => {
		const context = createMockRelayProtocolContext("sess-a");

		const normalized = normalizeMockRelayMessages(
			[
				{ type: "thinking_stop" },
				{ type: "user_message", text: "hello" },
				{ type: "delta", text: "world" },
				{ type: "done", code: 0 },
			],
			context,
		);

		expect(normalized).toEqual([
			{ type: "thinking_stop", sessionId: "sess-a" },
			{ type: "user_message", text: "hello", sessionId: "sess-a" },
			{ type: "delta", text: "world", sessionId: "sess-a" },
			{ type: "done", code: 0, sessionId: "sess-a" },
		]);
	});

	it("uses an explicit sessionId for session-scoped events", () => {
		const context = createMockRelayProtocolContext();
		expect(
			normalizeMockRelayMessage(
				{ type: "user_message", text: "question", sessionId: "sess-history" },
				context,
			),
		).toEqual({
			type: "user_message",
			text: "question",
			sessionId: "sess-history",
		});
	});

	it("preserves explicit sessionId for cross-session events", () => {
		const context = createMockRelayProtocolContext("sess-current");

		expect(
			normalizeMockRelayMessage(
				{
					type: "done",
					sessionId: "sess-other",
					code: 0,
				},
				context,
			),
		).toMatchObject({
			type: "done",
			sessionId: "sess-other",
		});
	});
});

describe("E2E WebSocket mock connection lifecycle", () => {
	const page = {} as Page;
	const control = new WsMockControl(page, {} as RpcMockControl);

	beforeEach(() => vi.clearAllMocks());

	it.each([
		"disconnected",
		"unknown",
		undefined,
		null,
		0,
	])("rejects unsupported connection_status %s instead of dropping the frame", (status) => {
		expect(() =>
			control.sendMessage({ type: "connection_status", status }),
		).toThrow(/Unsupported connection_status/);
		expect(sendMockProjectSetting).not.toHaveBeenCalled();
	});

	it.each([
		"stopped",
		"starting",
		"connected",
		"reconnecting",
		"failed",
	])("publishes the current connection state %s", (status) => {
		control.sendMessage({ type: "connection_status", status });
		expect(sendMockProjectSetting).toHaveBeenCalledExactlyOnceWith(page, {
			_tag: "opencodeConnection",
			instanceId: "opencode",
			status,
		});
	});

	it.each([
		"side-thread",
		"fork-reply",
	])("replays the %s recording's outage and recovery through project settings", (name) => {
		const fixture = JSON.parse(
			readFileSync(
				new URL(`../../e2e/fixtures/recorded/${name}.json`, import.meta.url),
				"utf8",
			),
		) as { initMessages: MockMessage[]; turns: { events: MockMessage[] }[] };
		const states = [
			...fixture.initMessages,
			...fixture.turns.flatMap((turn) => turn.events),
		].filter((message) => message.type === "connection_status");
		for (const message of states) control.sendMessage(message);
		expect(vi.mocked(sendMockProjectSetting).mock.calls).toEqual([
			[
				page,
				{
					_tag: "opencodeConnection",
					instanceId: "opencode",
					status: "reconnecting",
				},
			],
			[
				page,
				{
					_tag: "opencodeConnection",
					instanceId: "opencode",
					status: "connected",
				},
			],
		]);
	});
});
