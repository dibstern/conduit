import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
	rpc: vi.fn(async () => {}),
}));
const list = vi.hoisted(() => ({
	refreshListedSessions: vi.fn(async () => {}),
}));

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		...rpc,
	}),
);
vi.mock(
	"../../../src/lib/frontend/stores/session-list.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		...list,
	}),
);
vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		getCurrentSlug: () => "home",
	}),
);

import {
	getSessionCommands,
	sessionCommandActions,
} from "../../../src/lib/frontend/components/session/session-commands.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";

const foreign: SessionInfo = {
	accountId: null,
	id: "s1",
	title: "Elsewhere",
	status: "idle",
	projectSlug: "elsewhere",
};

describe("a session from another project (all-projects view)", () => {
	beforeEach(() => vi.clearAllMocks());

	it("offers the same commands as a session from the attached project", () => {
		const testIds = (session: SessionInfo) =>
			getSessionCommands(
				session,
				Date.now(),
				{ rename: () => {} },
				"center",
			).map((entry) => ("testId" in entry ? entry.testId : "divider"));
		expect(testIds(foreign)).toEqual(
			testIds({ ...foreign, projectSlug: "home" }),
		);
	});

	it("sends the change to the session's own project, then refreshes its row", async () => {
		await sessionCommandActions.settle(foreign, true);
		expect(rpc.rpc).toHaveBeenCalledWith(
			"SetSessionSettled",
			expect.objectContaining({
				projectSlug: "elsewhere",
				sessionId: "s1",
				settled: true,
			}),
		);
		expect(list.refreshListedSessions).toHaveBeenCalledOnce();
	});

	it("does not refresh for a session of the attached project", async () => {
		await sessionCommandActions.pin({ ...foreign, projectSlug: "home" }, true);
		expect(rpc.rpc).toHaveBeenCalledWith(
			"SetSessionPinned",
			expect.objectContaining({ projectSlug: "home", pinned: true }),
		);
		expect(list.refreshListedSessions).not.toHaveBeenCalled();
	});
});
