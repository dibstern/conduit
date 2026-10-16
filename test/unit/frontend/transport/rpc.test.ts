import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Cause, Effect, Exit, Fiber, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { AccountUnroutable } from "../../../../src/lib/contracts/limit-recovery.js";
import { WsRpcError } from "../../../../src/lib/contracts/ws-rpc.js";
import { disposeRuntime } from "../../../../src/lib/frontend/transport/runtime.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcClients,
} from "../../../../src/lib/frontend/transport/shared-client.js";
import {
	rpc,
	rpcEffect,
} from "../../../../src/lib/frontend/transport/ws-rpc-client.js";

const runtimeMock = vi.hoisted(() => ({ runTransportEffect: vi.fn() }));
vi.mock("../../../../src/lib/frontend/transport/runtime.js", () => ({
	runTransportEffect: runtimeMock.runTransportEffect,
	disposeRuntime: vi.fn(),
}));

import { makeRpcWire } from "../../../helpers/rpc-wire.js";
import type { StubTable } from "../../../helpers/stub-ws-rpc.js";

function adapter() {
	const table: StubTable = {};
	const wire = makeRpcWire(table);
	return {
		...wire,
		stub: (stubs: StubTable) => Object.assign(table, stubs),
		async request(tag: string) {
			await vi.waitFor(() =>
				expect(wire.requests.some((frame) => frame.tag === tag)).toBe(true),
			);
			const request = wire.requests.find((frame) => frame.tag === tag);
			if (!request) throw new Error(`no ${tag} request`);
			return request;
		},
	};
}

let wire: ReturnType<typeof adapter>;
let runtime: ManagedRuntime.ManagedRuntime<WsRpcClients, never>;
beforeEach(() => {
	vi.stubGlobal("location", { protocol: "http:", host: "localhost:2633" });
	wire = adapter();
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	runtimeMock.runTransportEffect.mockImplementation((effect) =>
		runtime.runPromise(effect),
	);
});
afterEach(async () => {
	await runtime.dispose();
	await disposeRuntime();
	runtimeMock.runTransportEffect.mockReset();
	vi.unstubAllGlobals();
});

it.each([
	undefined,
	"session-1",
])("returns worktrees unchanged with optional session %s", async (sessionId) => {
	const payload =
		sessionId === undefined ? { projectSlug: "other-project" } : { sessionId };
	const value = {
		worktrees: [{ path: "/work/tree", branch: "topic", main: false }],
		directory: "/work",
	};
	wire.stub({ ListWorktrees: () => value });
	await expect(rpc("ListWorktrees", payload)).resolves.toEqual(value);
	const request = await wire.request("ListWorktrees");
	expect(request.payload).toEqual({ _tag: request.tag, ...payload });
});

it.each([
	"queue",
	"steer",
] as const)("sends input %s verbatim and returns the response union", async (delivery) => {
	const payload = {
		sessionId: "s1",
		inputId: "i1",
		text: "",
		delivery,
		images: [],
		originId: "browser",
	};
	const value =
		delivery === "queue"
			? { ok: true as const, sessionId: "s1" }
			: { ok: false as const, reason: "no_steering" as const };
	wire.stub({ "input.submit": () => value });
	await expect(rpc("input.submit", payload)).resolves.toEqual(value);
	const request = await wire.request("input.submit");
	expect(request.payload).toEqual({ _tag: request.tag, ...payload });
});

it("rejects with the declared error instance and exposes tag narrowing in Effect", async () => {
	wire.stub({
		"input.submit": () => {
			throw new AccountUnroutable({
				ref: { _tag: "DriverDefault", driver: "claude" },
			});
		},
	});
	const result = await runtime.runPromise(
		Effect.either(
			rpcEffect("input.submit", {
				sessionId: "s1",
				inputId: "i1",
				text: "hello",
				delivery: "queue",
			}),
		),
	);
	if (result._tag === "Left" && result.left._tag === "AccountUnroutable") {
		expectTypeOf(result.left).toEqualTypeOf<AccountUnroutable>();
		expect(result.left).toBeInstanceOf(AccountUnroutable);
		expect(result.left.ref).toEqual({
			_tag: "DriverDefault",
			driver: "claude",
		});
	} else throw new Error("declared error did not reach the caller");
});

it("rejects the Promise with a declared error instance", async () => {
	wire.stub({
		ListWorktrees: () => {
			throw new WsRpcError({ message: "refused" });
		},
	});
	await expect(
		rpc("ListWorktrees", { projectSlug: "alpha" }),
	).rejects.toBeInstanceOf(WsRpcError);
});

it("rejects an in-flight call on socket drop instead of hanging", async () => {
	const pending = rpc("ListWorktrees", { projectSlug: "alpha" });
	const rejected = expect(pending).rejects.toBeInstanceOf(RpcClientError);
	await wire.request("ListWorktrees");
	const connection = wire.connections.find((c) => c.trafficClass === "control");
	if (!connection) throw new Error("missing control connection");
	await Effect.runPromise(connection.drop);
	await rejected;
}, 2000);

it.each([
	"server bug",
	new Cause.InterruptedException(),
])("normalizes a non-declared throw to the client error: %s", async (error) => {
	wire.stub({
		ListWorktrees: () => {
			throw error;
		},
	});
	await expect(
		rpc("ListWorktrees", { projectSlug: "alpha" }),
	).rejects.toBeInstanceOf(RpcClientError);
});

it("does not inject an optional project into the payload", async () => {
	wire.stub({ SetLogLevel: () => ({ ok: true }) });
	await rpc("SetLogLevel", { level: "debug" });
	expect((await wire.request("SetLogLevel")).payload).toEqual({
		_tag: "SetLogLevel",
		level: "debug",
	});
});

it("keeps caller cancellation as an interruption", async () => {
	const fiber = runtime.runFork(
		rpcEffect("ListWorktrees", { projectSlug: "alpha" }),
	);
	await wire.request("ListWorktrees");
	expect(
		Exit.isInterrupted(await Effect.runPromise(Fiber.interrupt(fiber))),
	).toBe(true);
});

it("delivers a subscription and a unary response on the same client", async () => {
	const { WsRpcClients } = await import(
		"../../../../src/lib/frontend/transport/shared-client.js"
	);
	const envelope = { _tag: "draft", text: "draft", from: "browser" } as const;
	wire.stub({
		SubscribeInputDraft: () => Stream.succeed(envelope),
		ListWorktrees: () => ({ worktrees: [] }),
	});
	const stream = runtime.runPromise(
		Effect.gen(function* () {
			const clients = yield* WsRpcClients;
			const sockets = yield* clients.forProject("alpha");
			return yield* Stream.runHead(
				sockets.subscriptions.inputDraft({ sessionId: "s1" }),
			);
		}),
	);
	const pending = rpc("ListWorktrees", { projectSlug: "beta" });
	await expect(stream).resolves.toMatchObject({
		_tag: "Some",
		value: envelope,
	});
	await expect(pending).resolves.toEqual({ worktrees: [] });
});

// Compiled by pnpm check, never executed.
function contractTypes() {
	const worktrees = rpc("ListWorktrees", { projectSlug: "alpha" });
	expectTypeOf(worktrees).resolves.toHaveProperty("worktrees");
	const submit = rpc("input.submit", {
		sessionId: "s1",
		inputId: "i1",
		text: "",
		delivery: "steer",
	});
	expectTypeOf(submit).resolves.toEqualTypeOf<
		import("../../../../src/lib/contracts/ws-rpc.js").SubmitInputResponse
	>();
	// @ts-expect-error Stream tags cannot be called as unary RPCs.
	rpc("SubscribeShell", { projectSlug: "alpha" });
	// @ts-expect-error The Effect call also accepts only unary tags.
	rpcEffect("SubscribeInputDraft", { sessionId: "s1" });
	// @ts-expect-error Contract payload fields are required.
	rpc("input.submit", { sessionId: "s1", text: "" });
	// @ts-expect-error Unknown payload fields must not be accepted.
	rpc("ListWorktrees", { projectSlug: "alpha", unknown: true });
}
void contractTypes;
