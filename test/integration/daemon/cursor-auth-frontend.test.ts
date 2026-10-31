// Failure modes: the displayed row authenticates the default account instead,
// two rows share busy/error state, and a late status reply crosses accounts.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as auth from "../../../src/lib/frontend/stores/cursor-auth.svelte.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const transport = vi.hoisted(() => ({
	rpc: vi.fn<
		(tag: string, input: { accountId?: string }) => Promise<unknown>
	>(),
}));
vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	() => transport,
);
vi.mock(
	"../../../src/lib/frontend/components/layout/chrome-actions.js",
	() => ({ openSettings: vi.fn() }),
);
let harness: ProcessHarness | undefined;
const scenarios: Record<string, unknown>[] = [];
afterEach(async ({ task }) => {
	await harness?.dispose();
	scenarios.push({
		scenario: task.name,
		result: task.result?.state,
		failures: task.result?.errors?.map(({ message }) => message),
		calls: transport.rpc.mock.calls,
		remainingRunners: harness?.remainingRunnerPids() ?? [],
	});
	writeFileSync(
		"/tmp/conduit-82tn9-5-auth-frontend-fixed.json",
		JSON.stringify(scenarios, null, 2),
	);
	transport.rpc.mockClear();
	harness = undefined;
});

it("targets the displayed non-default account for status, logout, login and cancellation", async () => {
	harness = ProcessHarness.create({
		dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
	});
	const fixture = harness;
	const statePath = join(fixture.root, "auth.json");
	const trace = resolve("test/fixtures/cursor-sdk-traces/auth-login.jsonl");
	writeFileSync(
		statePath,
		JSON.stringify({
			status: { status: "logged-out" },
			credential: null,
			accounts: {},
		}),
	);
	await fixture.restart({
		startupTimeoutMs: 90_000,
		serviceEnvironment: {
			CONDUIT_CURSOR_SDK_TRACE: trace,
			CONDUIT_TEST_CURSOR_AUTH_STATE: statePath,
			CONDUIT_TEST_CURSOR_LOGIN_DELAY_MS: "1200",
		},
	});
	const ids: string[] = [];
	for (const name of ["Displayed A", "Default B"]) {
		const { addedInstanceId } = await fixture.requestRpc({
			_tag: "AddInstance",
			driver: "cursor",
			name,
		});
		if (!addedInstanceId) throw new Error("Missing account");
		ids.push(addedInstanceId);
	}
	const [a, b] = ids as [string, string];
	await fixture.requestRpc({ _tag: "SetDefault", instanceId: b });
	const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<
		string,
		unknown
	>;
	state["accounts"] = Object.fromEntries(
		ids.map((id) => [
			id,
			{
				status: {
					status: "logged-in",
					backendUrl: "https://api2.cursor.sh",
					email: `${id}@example.test`,
				},
				credential: {
					apiKey: `[REDACTED:${id}]`,
					backendUrl: "https://api2.cursor.sh",
					email: `${id}@example.test`,
					createdAtMs: Date.now(),
				},
			},
		]),
	);
	writeFileSync(statePath, JSON.stringify(state));
	transport.rpc.mockImplementation((tag, input) => {
		const selection = input.accountId ? { accountId: input.accountId } : {};
		switch (tag) {
			case "GetCursorAuth":
				return fixture.requestRpc({ _tag: tag, ...selection });
			case "StartCursorLogin":
				return fixture.requestRpc({ _tag: tag, ...selection });
			case "CancelCursorLogin":
				return fixture.requestRpc({ _tag: tag, ...selection });
			case "LogoutCursor":
				return fixture.requestRpc({ _tag: tag, ...selection });
			default:
				throw new Error(`Unexpected auth RPC: ${tag}`);
		}
	});
	await auth.refreshCursorAuth(a);
	expect(transport.rpc).toHaveBeenLastCalledWith("GetCursorAuth", {
		accountId: a,
	});
	await auth.refreshCursorAuth(b);
	expect(auth.cursorAuthFor(a)).toMatchObject({
		accountId: a,
		current: { email: `${a}@example.test` },
	});
	expect(auth.cursorAuthFor(b)).toMatchObject({
		accountId: b,
		current: { email: `${b}@example.test` },
	});
	await auth.changeCursorAuth("LogoutCursor", a);
	expect(transport.rpc).toHaveBeenLastCalledWith("LogoutCursor", {
		accountId: a,
	});
	expect(
		await fixture.requestRpc({ _tag: "GetCursorAuth", accountId: b }),
	).toMatchObject({ status: "logged-in" });
	await auth.changeCursorAuth("StartCursorLogin", a);
	expect(transport.rpc).toHaveBeenLastCalledWith("StartCursorLogin", {
		accountId: a,
	});
	expect(auth.cursorAuthFor(a).current?.login.state).toBe("pending");
	await auth.changeCursorAuth("CancelCursorLogin", a);
	expect(transport.rpc).toHaveBeenLastCalledWith("CancelCursorLogin", {
		accountId: a,
	});
	expect(auth.cursorAuthFor(a).current?.login.state).toBe("cancelled");
	expect(auth.cursorAuthFor(b).current?.status).toBe("logged-in");
}, 120_000);

it("keeps concurrent and late status replies associated with their account", async () => {
	let release: (value: unknown) => void = () => {};
	transport.rpc.mockImplementation((_tag, input) =>
		input.accountId === "late-a"
			? new Promise((done) => {
					release = done;
				})
			: Promise.resolve({
					status: "logged-out",
					source: "none",
					expiresSoon: false,
					login: { state: "idle" },
				}),
	);
	const first = auth.refreshCursorAuth("late-a");
	const second = auth.refreshCursorAuth("ready-b");
	expect(transport.rpc).toHaveBeenLastCalledWith("GetCursorAuth", {
		accountId: "ready-b",
	});
	release({
		status: "logged-in",
		source: "sdk-login",
		email: "a@example.test",
		expiresSoon: false,
		login: { state: "idle" },
	});
	await Promise.all([first, second]);
	expect(auth.cursorAuthFor("late-a")).toMatchObject({
		accountId: "late-a",
		current: { email: "a@example.test" },
	});
	expect(auth.cursorAuthFor("ready-b")).toMatchObject({
		accountId: "ready-b",
		current: { status: "logged-out" },
	});
});

it("ignores a status reply superseded by logout and isolates status failures and the empty state", async () => {
	let release: (value: unknown) => void = () => {};
	const loggedOut = {
		status: "logged-out",
		source: "none",
		expiresSoon: false,
		login: { state: "idle" },
	};
	transport.rpc.mockImplementation((tag, input) => {
		if (input.accountId === "unavailable")
			return Promise.reject(new Error("Removed account"));
		if (tag === "GetCursorAuth" && input.accountId === "stale")
			return new Promise((done) => {
				release = done;
			});
		return Promise.resolve(loggedOut);
	});
	const pending = auth.refreshCursorAuth("stale");
	await auth.changeCursorAuth("LogoutCursor", "stale");
	await auth.refreshCursorAuth("unavailable");
	release({ ...loggedOut, status: "logged-in", email: "old@example.test" });
	await pending;
	expect(auth.cursorAuthFor("stale")).toMatchObject({
		current: { status: "logged-out" },
		busy: false,
		error: undefined,
	});
	expect(auth.cursorAuthFor("unavailable").error).toContain("Could not check");
	await auth.refreshCursorAuth(undefined);
	expect(transport.rpc).toHaveBeenLastCalledWith("GetCursorAuth", {});
	expect(auth.cursorAuthFor(undefined)).toMatchObject({
		accountId: undefined,
		current: { status: "logged-out" },
		error: undefined,
	});
});
