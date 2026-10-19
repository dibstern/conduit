import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
	rpc: vi.fn(async () => {}),
}));

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		...rpc,
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

	it("addresses a settle command by session", async () => {
		await sessionCommandActions.settle(foreign, true);
		expect(rpc.rpc).toHaveBeenCalledWith(
			"SetSessionSettled",
			expect.objectContaining({
				sessionId: foreign.id,
				settled: true,
			}),
		);
	});

	it("addresses a pin command by session", async () => {
		await sessionCommandActions.pin({ ...foreign, projectSlug: "home" }, true);
		expect(rpc.rpc).toHaveBeenCalledWith(
			"SetSessionPinned",
			expect.objectContaining({ sessionId: foreign.id, pinned: true }),
		);
	});
});
