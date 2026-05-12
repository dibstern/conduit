import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import {
	handleListSessions,
	handleViewSession,
} from "../../../src/lib/handlers/session.js";
import {
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockSessionManagerShape,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
	type RecordedWebSocketCall,
} from "../../helpers/mock-factories.js";

const snapshotPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../snapshots/handlers/sessions.json",
);

const readSnapshots = (): Record<string, RecordedWebSocketCall[]> =>
	JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<
		string,
		RecordedWebSocketCall[]
	>;

describe("session handler wire snapshots", () => {
	it("keeps the view_session model metadata envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeMockOpenCodeAPI();
		vi.spyOn(api.session, "get").mockResolvedValue({
			id: "session-1",
			projectID: "project-1",
			directory: "/tmp/project",
			title: "Session 1",
			version: "1.0.0",
			time: { created: 0, updated: 0 },
			modelID: "gpt-4",
			providerID: "openai",
		});
		vi.spyOn(api.permission, "list").mockResolvedValue([]);
		vi.spyOn(api.question, "list").mockResolvedValue([]);
		const sessionMgr = makeMockSessionManagerShape({
			loadPreRenderedHistory: vi.fn(async () => ({
				messages: [],
				hasMore: false,
				total: 0,
			})),
			sendDualSessionLists: vi.fn(async () => undefined),
		});

		await Effect.runPromise(
			handleViewSession("client-1", { sessionId: "session-1" }).pipe(
				Effect.provide(makeTestHandlerLayer({ api, wsHandler, sessionMgr })),
			),
		);

		const modelInfoCalls = calls.filter(
			(call) => call.message.type === "model_info",
		);
		expect(modelInfoCalls).toEqual(
			readSnapshots()["view_session_model_info_success"],
		);
	});

	it("keeps the list_sessions envelopes stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			sendDualSessionLists: vi.fn((send) =>
				Effect.sync(() => {
					send({
						type: "session_list",
						sessions: [
							{
								id: "root-1",
								title: "Root Session",
								updatedAt: 100,
								messageCount: 2,
							},
						],
						roots: true,
					});
					send({
						type: "session_list",
						sessions: [
							{
								id: "child-1",
								title: "Child Session",
								updatedAt: 200,
								messageCount: 4,
								parentID: "root-1",
							},
						],
						roots: false,
					});
				}),
			),
		});

		await Effect.runPromise(
			handleListSessions("client-1", {}).pipe(
				Effect.provide(
					makeTestHandlerLayer({ wsHandler, sessionManagerService }),
				),
			),
		);

		expect(calls).toEqual(readSnapshots()["list_sessions_success"]);
	});
});
