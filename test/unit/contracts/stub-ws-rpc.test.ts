import {
	Arbitrary,
	Effect,
	Fiber,
	ManagedRuntime,
	Schema,
	Stream,
} from "effect";
import { RpcSchema } from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";
import fc from "fast-check";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	makeWsRpcClientsLayer,
	WsRpcClients,
} from "../../../src/lib/frontend/transport/shared-client.js";
import { rpcEffect } from "../../../src/lib/frontend/transport/ws-rpc-client.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";
import { type StubTable, stubWsRpc } from "../../helpers/stub-ws-rpc.js";

let runtime: ManagedRuntime.ManagedRuntime<WsRpcClients, never> | undefined;
beforeEach(() => {
	vi.stubGlobal("location", { protocol: "http:", host: "localhost:2633" });
});
afterEach(async () => {
	await runtime?.dispose();
	vi.unstubAllGlobals();
});
const serve = (table: StubTable) => {
	const wire = makeRpcWire(table);
	runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	return { wire, runtime };
};

it("rejects a stub reply the contract cannot encode", async () => {
	const { runtime } = serve({
		// @ts-expect-error Deliberately exercise schema validation at runtime too.
		ListWorktrees: () => ({ worktrees: "stale fixture" }),
	});
	const result = await runtime.runPromise(
		Effect.either(rpcEffect("ListWorktrees", { projectSlug: "p" })),
	);
	expect(result).toMatchObject({ _tag: "Left" });
	if (result._tag === "Left") {
		expect(result.left).toBeInstanceOf(RpcClientError);
		expect(String(result.left.cause)).toContain("worktrees");
	}
});

it.each([
	"sync",
	"async",
])("turns a non-declared %s throw into a defect", async (kind) => {
	const fail = () => {
		throw new Error("stub bug");
	};
	const { runtime } = serve({
		ListWorktrees: kind === "sync" ? fail : async () => fail(),
	});
	const result = await runtime.runPromise(
		Effect.either(rpcEffect("ListWorktrees", { projectSlug: "p" })),
	);
	if (result._tag !== "Left") throw new Error("call succeeded");
	expect(result.left).toBeInstanceOf(RpcClientError);
	expect(String(result.left.cause)).toContain("stub bug");
});

it("leaves an omitted tag unanswered while other calls still work", async () => {
	const { wire, runtime } = serve({ SetLogLevel: () => ({ ok: true }) });
	const pending = runtime.runFork(
		rpcEffect("ListWorktrees", { projectSlug: "p" }),
	);
	await vi.waitFor(() =>
		expect(wire.requests.some((r) => r.tag === "ListWorktrees")).toBe(true),
	);
	await expect(
		runtime.runPromise(rpcEffect("SetLogLevel", { level: "debug" })),
	).resolves.toEqual({ ok: true });
	expect(await Effect.runPromise(Fiber.poll(pending))).toMatchObject({
		_tag: "None",
	});
});

it("round-trips every declared error class as its own instance", async () => {
	const checked = new Set<string>();
	for (const rpc of WsRpcGroup.requests.values()) {
		const stream = RpcSchema.getStreamSchemas(rpc.successSchema.ast);
		const schemas =
			stream._tag === "Some"
				? [rpc.errorSchema.ast, stream.value.failure.ast]
				: [rpc.errorSchema.ast];
		const variants = [...schemas];
		for (const ast of variants) {
			if (ast._tag === "Union") {
				variants.push(...ast.types);
				continue;
			}
			if (ast._tag === "NeverKeyword") continue;
			const error = fc.sample(Arbitrary.make(Schema.make(ast)), {
				seed: 42,
				numRuns: 1,
			})[0];
			if (typeof error !== "object" || error === null || !("_tag" in error))
				throw new Error("untagged error");
			if (checked.has(String(error._tag))) continue;
			checked.add(String(error._tag));
			const payload = fc.sample(
				Arbitrary.make(Schema.make(rpc.payloadSchema.ast)),
				{ seed: 42, numRuns: 1 },
			)[0];
			const { runtime: current } = serve({
				[rpc._tag]: () => {
					throw error;
				},
			});
			// The loop checks each schema dynamically; the contract supplies both values.
			const result = await current.runPromise(
				Effect.gen(function* () {
					const clients = yield* WsRpcClients;
					const sockets = yield* clients.forProject("");
					const call = sockets.control as (
						tag: string,
						payload: unknown,
					) =>
						| Effect.Effect<unknown, unknown>
						| Stream.Stream<unknown, unknown>;
					const response = call(rpc._tag, payload);
					return yield* Effect.either(
						Effect.isEffect(response) ? response : Stream.runDrain(response),
					);
				}),
			);
			if (result._tag !== "Left") throw new Error(`${rpc._tag} succeeded`);
			expect(result.left, rpc._tag).toBeInstanceOf(error.constructor);
			// JSON omits optional fields whose value is undefined.
			expect(JSON.parse(JSON.stringify(result.left))).toEqual(
				JSON.parse(JSON.stringify(error)),
			);
			await current.dispose();
		}
	}
	expect(checked.size).toBeGreaterThan(1);
});

// Compiled by pnpm check, never executed.
function contractTypes() {
	// @ts-expect-error Unknown RPC tags are rejected.
	stubWsRpc({ UnknownRpc: () => ({}) });
	stubWsRpc({
		// @ts-expect-error The payload comes from the contract.
		ListWorktrees: (_payload: { sessionId: number }) => ({ worktrees: [] }),
	});
	stubWsRpc({ SubscribeShell: () => Stream.never });
}
void contractTypes;
