import { describe, expect, it, vi } from "vitest";
import {
	resolveSession,
	resolveSessionForLog,
} from "../../../src/lib/handlers/resolve-session.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("resolveSession", () => {
	it("returns client session when available", () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses_client");
		expect(resolveSession(deps, "c1")).toBe("ses_client");
	});

	it("returns undefined when client has no session", () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		expect(resolveSession(deps, "c1")).toBeUndefined();
	});
});

describe("resolveSessionForLog", () => {
	it("returns '?' when no session", () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		expect(resolveSessionForLog(deps, "c1")).toBe("?");
	});

	it("returns session ID when available", () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses_123");
		expect(resolveSessionForLog(deps, "c1")).toBe("ses_123");
	});
});
