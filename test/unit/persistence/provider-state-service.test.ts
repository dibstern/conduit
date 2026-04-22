// test/unit/persistence/provider-state-service.test.ts

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderStateService } from "../../../src/lib/persistence/provider-state-service.js";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("ProviderStateService", () => {
	let harness: TestHarness;
	let service: ProviderStateService;

	beforeEach(() => {
		harness = createTestHarness();
		service = new ProviderStateService(harness.db);
		harness.seedSession("s1");
	});

	afterEach(() => {
		harness.close();
	});

	describe("getState", () => {
		it("returns empty object for unknown session", () => {
			expect(service.getState("nonexistent")).toEqual({});
		});

		it("returns empty object for session with no provider state", () => {
			expect(service.getState("s1")).toEqual({});
		});
	});

	describe("saveUpdates + getState round-trip", () => {
		it("round-trips provider state updates", () => {
			service.saveUpdates("s1", [
				{ key: "resume_cursor", value: "cursor_abc" },
				{ key: "last_event_id", value: "evt_123" },
			]);

			const state = service.getState("s1");
			expect(state).toEqual({
				resume_cursor: "cursor_abc",
				last_event_id: "evt_123",
			});
		});

		it("upserts on duplicate keys", () => {
			service.saveUpdates("s1", [{ key: "resume_cursor", value: "cursor_v1" }]);
			service.saveUpdates("s1", [{ key: "resume_cursor", value: "cursor_v2" }]);

			const state = service.getState("s1");
			expect(state).toEqual({
				resume_cursor: "cursor_v2",
			});
		});

		it("skips empty updates array", () => {
			service.saveUpdates("s1", []);
			expect(service.getState("s1")).toEqual({});
		});

		it("keeps state isolated between sessions", () => {
			harness.seedSession("s2");

			service.saveUpdates("s1", [{ key: "cursor", value: "s1_cursor" }]);
			service.saveUpdates("s2", [{ key: "cursor", value: "s2_cursor" }]);

			expect(service.getState("s1")).toEqual({ cursor: "s1_cursor" });
			expect(service.getState("s2")).toEqual({ cursor: "s2_cursor" });
		});
	});

	describe("clearState", () => {
		it("removes all state for a session", () => {
			service.saveUpdates("s1", [
				{ key: "resume_cursor", value: "cursor_abc" },
				{ key: "last_event_id", value: "evt_123" },
			]);

			service.clearState("s1");

			expect(service.getState("s1")).toEqual({});
		});

		it("does not affect other sessions", () => {
			harness.seedSession("s2");

			service.saveUpdates("s1", [{ key: "key1", value: "val1" }]);
			service.saveUpdates("s2", [{ key: "key2", value: "val2" }]);

			service.clearState("s1");

			expect(service.getState("s1")).toEqual({});
			expect(service.getState("s2")).toEqual({ key2: "val2" });
		});

		it("is a no-op for session with no state", () => {
			// Should not throw
			service.clearState("s1");
			expect(service.getState("s1")).toEqual({});
		});
	});
});
