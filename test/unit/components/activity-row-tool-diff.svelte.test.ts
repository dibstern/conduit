// An open tool-call Diff lists when the turn settles, not only when opened: a
// Write opened mid-run is listed before its run capture exists, so it can only
// say "may replace". Failure mode: the view outlives the run and keeps that.

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, expect, it, vi } from "vitest";

const listRpc = vi.hoisted(() =>
	vi.fn(async (_tag: string, _input: unknown) => ({
		revision: "r",
		folders: [],
		source: "provider",
	})),
);

vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: listRpc,
}));
// The live feed is not under test; it never opens.
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => ({
	getRuntime: () => new Promise(() => undefined),
	runTransportEffect: () => undefined,
}));

import ActivityRow from "../../../src/lib/frontend/components/chat/ActivityRow.svelte";
import type { ActivityPart } from "../../../src/lib/frontend/utils/turns.js";

const write = {
	type: "tool",
	uuid: "write-1",
	id: "call-write",
	name: "Write",
	input: { file_path: "/r/a.ts", content: "x\n" },
	status: "completed",
	result: "ok",
	fileChanges: [{ kind: "add", path: "/r/a.ts", after: "x\n" }],
} as ActivityPart;

afterEach(cleanup);

it("lists an open Diff again once its turn settles", async () => {
	// Only the turn's liveness changes; the harness's rerender would rebuild every prop.
	let turnLive = $state(true);
	render(ActivityRow, {
		props: {
			part: write,
			liveTasks: [],
			taskListedAt: new Map<string, number>(),
			sessionId: "s",
			get turnLive() {
				return turnLive;
			},
		},
	});
	await fireEvent.click(screen.getByRole("button", { name: /Wrote/ }));
	await fireEvent.click(screen.getByTestId("tool-diff-toggle"));
	expect(listRpc).toHaveBeenCalledTimes(1);

	flushSync(() => {
		turnLive = false;
	});

	expect(listRpc).toHaveBeenCalledTimes(2);
	expect(listRpc).toHaveBeenLastCalledWith("SessionDiffList", {
		sessionId: "s",
		scope: { kind: "toolCall", toolId: "call-write" },
	});
});
