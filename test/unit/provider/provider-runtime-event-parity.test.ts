import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { providerRuntimeEventToCanonicalEvent } from "../../../src/lib/provider/provider-runtime-event-to-canonical.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import type { RelayMessage } from "../../../src/lib/types.js";

const SESSION_ID = "ses-runtime-parity";
const CREATED_AT_ISO = "2026-05-18T00:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT_ISO);
const REPO_ROOT = process.cwd();

function tsFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];

	const files: string[] = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			files.push(...tsFiles(path));
		} else if (path.endsWith(".ts")) {
			files.push(relative(REPO_ROOT, path));
		}
	}
	return files.sort();
}

function runtimeEvent(
	overrides: Partial<ProviderRuntimeEvent> & Pick<ProviderRuntimeEvent, "type">,
): ProviderRuntimeEvent {
	const { type, ...rest } = overrides;
	return {
		eventId: `evt_${type.replaceAll(".", "_")}`,
		type,
		providerId: "claude",
		sessionId: SESSION_ID,
		turnId: "turn-1",
		providerRefs: {
			providerSessionId: "claude-session-1",
			providerMessageId: "claude-message-1",
		},
		rawSource: {
			kind: "claude-sdk",
			providerMessageType: "assistant",
			sourceSchema: "ClaudeSDKMessageSchema",
		},
		createdAt: CREATED_AT_ISO,
		data: {},
		...rest,
	};
}

describe("ProviderRuntimeEvent compatibility parity", () => {
	it("keeps provider and relay runtime paths from constructing canonical events directly", () => {
		const checkedRoots = ["src/lib/provider", "src/lib/relay"];
		const hits = checkedRoots.flatMap((root) =>
			tsFiles(join(REPO_ROOT, root)).flatMap((file) => {
				const source = readFileSync(join(REPO_ROOT, file), "utf8");
				return source
					.split("\n")
					.flatMap((line, index) =>
						/\bcanonicalEvent\(/.test(line)
							? [{ file, line: index + 1, source: line.trim() }]
							: [],
					);
			}),
		);

		expect(hits).toEqual([]);
	});

	it("translates Claude runtime events to the current canonical shape with provider refs in metadata", () => {
		const event = runtimeEvent({
			type: "tool.started",
			providerRefs: {
				providerSessionId: "claude-session-1",
				providerMessageId: "claude-message-1",
				providerToolUseId: "toolu_1",
			},
			data: {
				messageId: "msg-1",
				partId: "toolu_1",
				toolName: "Bash",
				callId: "toolu_1",
				input: { tool: "Bash", command: "pnpm check" },
			},
		});

		const canonical = providerRuntimeEventToCanonicalEvent(event);

		expect(canonical).toMatchObject({
			eventId: event.eventId,
			type: "tool.started",
			sessionId: SESSION_ID,
			provider: "claude",
			createdAt: CREATED_AT_MS,
			data: event.data,
			metadata: {
				providerRuntimeSource: "provider-runtime",
				providerRefs: event.providerRefs,
				rawSource: event.rawSource,
			},
		});
		expect(canonical.data).not.toHaveProperty("providerToolUseId");
	});

	it("translates OpenCode runtime events to canonical events without provider-specific payload ids", () => {
		const event = runtimeEvent({
			type: "permission.asked",
			providerId: "opencode",
			providerRefs: {
				providerSessionId: "opencode-session-1",
				providerRequestId: "perm-1",
			},
			rawSource: {
				kind: "opencode-sdk",
				streamEventType: "permission.asked",
				endpoint: "/event",
			},
			createdAt: CREATED_AT_MS,
			data: {
				id: "perm-1",
				sessionId: SESSION_ID,
				toolName: "Bash",
				input: { command: "pnpm check" },
			},
		});

		const canonical = providerRuntimeEventToCanonicalEvent(event);

		expect(canonical.provider).toBe("opencode");
		expect(canonical.createdAt).toBe(CREATED_AT_MS);
		expect(canonical.data).toEqual(event.data);
		expect(canonical.metadata.providerRefs).toEqual(event.providerRefs);
		expect(canonical.data).not.toHaveProperty("providerRequestId");
	});

	it("keeps relay messages stable when the relay sink receives runtime events", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: SESSION_ID, send });

		await Effect.runPromise(
			sink.push(
				runtimeEvent({
					type: "text.delta",
					data: { messageId: "msg-1", partId: "part-1", text: "hello" },
				}),
			),
		);

		const messages = send.mock.calls.map((call) => call[0] as RelayMessage);
		expect(messages).toEqual([
			{
				type: "delta",
				sessionId: SESSION_ID,
				text: "hello",
				messageId: "msg-1",
			},
		]);
	});
});
