import { RpcClient, type RpcMessage } from "@effect/rpc";
import { RpcClientError } from "@effect/rpc/RpcClientError";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import { AccountUnroutable } from "../../../../src/lib/contracts/limit-recovery.js";
import {
	WsRpcError,
	WsRpcGroup,
} from "../../../../src/lib/contracts/ws-rpc.js";
import { disposeRuntime } from "../../../../src/lib/frontend/transport/runtime.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcClients,
	type WsRpcConnect,
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

// The transcript interface's in-process protocol seam, with the real codec.
function adapter() {
	const requests: Array<RpcMessage.RequestEncoded> = [];
	let deliver:
		| ((frame: RpcMessage.FromServerEncoded) => Effect.Effect<void>)
		| undefined;
	const connect: WsRpcConnect = ({ trafficClass }) =>
		Effect.gen(function* () {
			const protocol = RpcClient.Protocol.make((write) =>
				Effect.sync(() => {
					if (trafficClass === "control") deliver = write;
					return {
						send: (frame: RpcMessage.FromClientEncoded) =>
							Effect.sync(() => {
								if (frame._tag === "Request") requests.push(frame);
							}),
						supportsAck: false,
						supportsTransferables: false,
					};
				}),
			);
			return yield* Layer.build(
				Layer.effect(RpcClient.Protocol, protocol),
			).pipe(
				Effect.flatMap((context) =>
					Effect.provide(
						RpcClient.make(WsRpcGroup, { flatten: true }),
						context,
					),
				),
			);
		});
	return {
		connect,
		requests,
		async emit(frame: RpcMessage.FromServerEncoded) {
			if (!deliver) throw new Error("control socket has not opened");
			await Effect.runPromise(deliver(frame));
		},
		async request(tag: string) {
			await vi.waitFor(() =>
				expect(requests.some((frame) => frame.tag === tag)).toBe(true),
			);
			const request = requests.find((frame) => frame.tag === tag);
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
	const payload = {
		projectSlug: "other-project",
		...(sessionId === undefined ? {} : { sessionId }),
	};
	const pending = rpc("ListWorktrees", payload);
	const request = await wire.request("ListWorktrees");
	expect(request.payload).toEqual({ _tag: request.tag, ...payload });
	const value = {
		worktrees: [{ path: "/work/tree", branch: "topic", main: false }],
		directory: "/work",
	};
	await wire.emit({
		_tag: "Exit",
		requestId: request.id,
		exit: { _tag: "Success", value },
	});
	await expect(pending).resolves.toEqual(value);
});

it.each([
	"queue",
	"steer",
] as const)("sends input %s verbatim and returns the response union", async (delivery) => {
	const payload = {
		projectSlug: "alpha",
		sessionId: "s1",
		inputId: "i1",
		text: "",
		delivery,
		images: [],
		originId: "browser",
	};
	const pending = rpc("input.submit", payload);
	const request = await wire.request("input.submit");
	expect(request.payload).toEqual({ _tag: request.tag, ...payload });
	const value =
		delivery === "queue"
			? { ok: true, sessionId: "s1" }
			: { ok: false, reason: "no_steering" };
	await wire.emit({
		_tag: "Exit",
		requestId: request.id,
		exit: { _tag: "Success", value },
	});
	await expect(pending).resolves.toEqual(value);
});

it("rejects with the declared error instance and exposes tag narrowing in Effect", async () => {
	const pending = runtime.runPromise(
		Effect.either(
			rpcEffect("input.submit", {
				projectSlug: "alpha",
				sessionId: "s1",
				inputId: "i1",
				text: "hello",
				delivery: "queue",
			}),
		),
	);
	const request = await wire.request("input.submit");
	await wire.emit({
		_tag: "Exit",
		requestId: request.id,
		exit: {
			_tag: "Failure",
			cause: {
				_tag: "Fail",
				error: {
					_tag: "AccountUnroutable",
					ref: { _tag: "DriverDefault", driver: "claude" },
				},
			},
		},
	});
	const result = await pending;
	expect(result._tag).toBe("Left");
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
	const pending = rpc("ListWorktrees", { projectSlug: "alpha" });
	const rejected = expect(pending).rejects.toBeInstanceOf(WsRpcError);
	const request = await wire.request("ListWorktrees");
	await wire.emit({
		_tag: "Exit",
		requestId: request.id,
		exit: {
			_tag: "Failure",
			cause: {
				_tag: "Fail",
				error: { _tag: "WsRpcError", message: "refused" },
			},
		},
	});
	await rejected;
});

it("rejects an in-flight call on socket drop instead of hanging", async () => {
	const pending = rpc("ListWorktrees", { projectSlug: "alpha" });
	const rejected = expect(pending).rejects.toBeInstanceOf(RpcClientError);
	await wire.request("ListWorktrees");
	await wire.emit({
		_tag: "ClientProtocolError",
		error: new RpcClientError({ reason: "Protocol", message: "socket closed" }),
	});
	await rejected;
}, 2000);

it.each([
	{ _tag: "Die", defect: "server bug" },
	{ _tag: "Interrupt", fiberId: { _tag: "None" } },
] as const)("normalizes a server $_tag failure to the client error", async (cause) => {
	const pending = rpc("ListWorktrees", { projectSlug: "alpha" });
	const rejected = expect(pending).rejects.toBeInstanceOf(RpcClientError);
	const request = await wire.request("ListWorktrees");
	await wire.emit({
		_tag: "Exit",
		requestId: request.id,
		exit: { _tag: "Failure", cause },
	});
	await rejected;
});

it("does not inject an optional project into the payload", async () => {
	const pending = rpc("SetLogLevel", { level: "debug" });
	const request = await wire.request("SetLogLevel");
	expect(request.payload).toEqual({ _tag: "SetLogLevel", level: "debug" });
	await wire.emit({
		_tag: "Exit",
		requestId: request.id,
		exit: { _tag: "Success", value: { ok: true } },
	});
	await pending;
});

it("keeps caller cancellation as an interruption", async () => {
	const fiber = runtime.runFork(
		rpcEffect("ListWorktrees", { projectSlug: "alpha" }),
	);
	await wire.request("ListWorktrees");
	const exit = await Effect.runPromise(Fiber.interrupt(fiber));
	expect(Exit.isInterrupted(exit)).toBe(true);
});

it("delivers a subscription and a unary response on the same client", async () => {
	const { WsRpcClients } = await import(
		"../../../../src/lib/frontend/transport/shared-client.js"
	);
	const stream = runtime.runPromise(
		Effect.gen(function* () {
			const clients = yield* WsRpcClients;
			const sockets = yield* clients.forProject("alpha");
			return yield* Stream.runHead(
				sockets.subscriptions.inputDraft({ sessionId: "s1" }),
			);
		}),
	);
	const subscription = await wire.request("SubscribeInputDraft");
	const pending = rpc("ListWorktrees", { projectSlug: "beta" });
	const unary = await wire.request("ListWorktrees");
	const envelope = { _tag: "draft", text: "draft", from: "browser" };
	await wire.emit({
		_tag: "Chunk",
		requestId: subscription.id,
		values: [envelope],
	});
	await wire.emit({
		_tag: "Exit",
		requestId: unary.id,
		exit: { _tag: "Success", value: { worktrees: [] } },
	});
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
		projectSlug: "alpha",
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
	rpcEffect("SubscribeInputDraft", { projectSlug: "alpha", sessionId: "s1" });
	// @ts-expect-error Contract payload fields are required.
	rpc("input.submit", { projectSlug: "alpha", sessionId: "s1", text: "" });
	// @ts-expect-error Unknown payload fields must not be accepted.
	rpc("ListWorktrees", { projectSlug: "alpha", unknown: true });
}
void contractTypes;
