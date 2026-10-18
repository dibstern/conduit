import {
	Arbitrary,
	Effect,
	type Result as Either,
	Schema,
	Stream,
} from "effect";
import { RpcSchema } from "effect/rpc";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WsRpcGroup, WsRpcRequest } from "../../../src/lib/contracts/ws-rpc.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

const options = { seed: 42, numRuns: 30, endOnFailure: true };
const json = (value: unknown): unknown =>
	value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Generate the wire side, then decode so transformed requests have canonical
// account references and tagged errors are instances of their declared class.
const values = (schema: Schema.Schema<unknown, unknown>) =>
	(schema.ast._tag === "VoidKeyword"
		? fc.constant(undefined)
		: Arbitrary.makeLazy(Schema.encodedBoundSchema(schema))({
				...fc,
				float: (constraints) =>
					fc.float({ ...constraints, noNaN: true, noDefaultInfinity: true }),
				anything: () => fc.jsonValue({ maxDepth: 2 }),
			})
	).map((value) => Schema.decodeUnknownSync(schema)(json(value)));

type ContractClient = (
	tag: string,
	payload: unknown,
) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>;

const withClient = (
	table: StubTable,
	check: (
		call: (
			tag: string,
			payload: unknown,
		) => Promise<Either.Result<unknown, unknown>>,
	) => Promise<void>,
) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* makeRpcWire(table).connect({
					url: "ws://contract/rpc",
					trafficClass: "control",
				});
				// Reflection loses tag/payload correlation. Callers generate both
				// values from the same RPC's schemas before crossing this boundary.
				const call = client as ContractClient;
				yield* Effect.tryPromise({
					try: () =>
						check((tag, payload) => {
							const response = call(tag, payload);
							return Effect.runPromise(
								(Effect.isEffect(response)
									? response
									: Stream.runCollect(response).pipe(
											Effect.map((chunks) => Array.from(chunks)),
										)
								).pipe(Effect.result, Effect.timeout("3 seconds")),
							);
						}),
					catch: (error) => error,
				});
			}),
		),
	);

for (const rpc of WsRpcGroup.requests.values()) {
	const payloadSchema = Schema.make(rpc.payloadSchema.ast);
	// Some request transforms canonicalize legacy account-selection fields.
	// Generate their normal form, then require the next wire round trip to preserve it.
	const payloads = values(payloadSchema).map((payload) =>
		Schema.decodeUnknownSync(payloadSchema)(
			json(Schema.encodeSync(payloadSchema)(payload)),
		),
	);
	const stream = RpcSchema.isStreamSchema(rpc.successSchema)
		? rpc.successSchema
		: undefined;
	const successSchema = Schema.make((stream?.success ?? rpc.successSchema).ast);

	describe(`RPC contract properties: ${rpc._tag}`, () => {
		it("round-trips requests and responses through JSON and the stub server", async () => {
			let received: unknown;
			let reply: readonly unknown[] = [];
			await withClient(
				{
					[rpc._tag]: (request: unknown) => {
						received = request;
						return stream
							? Stream.fromIterable(reply).pipe(Stream.rechunk(1))
							: reply[0];
					},
				},
				(call) =>
					fc.assert(
						fc.asyncProperty(
							payloads,
							fc.array(values(successSchema), {
								minLength: stream ? 0 : 1,
								maxLength: stream ? 5 : 1,
							}),
							async (payload, success) => {
								const encodedPayload = json(
									Schema.encodeSync(payloadSchema)(payload),
								);
								reply = success;
								const result = await call(rpc._tag, payload);
								expect(received).toEqual(payload);
								expect(
									json(Schema.encodeSync(payloadSchema)(received)),
								).toEqual(encodedPayload);
								expect(result._tag).toBe("Right");
								if (result._tag === "Success") {
									expect(result.success).toEqual(stream ? success : success[0]);
								}
								if (!stream) {
									expect(
										Schema.decodeUnknownSync(WsRpcRequest)(encodedPayload),
									).toEqual(payload);
								}
							},
						),
						options,
					),
			);
		});

		const variants = [rpc.errorSchema.ast];
		if (stream) variants.push(stream.failure.ast);
		for (const [index, ast] of variants.entries()) {
			if (ast._tag === "Suspend") {
				variants.push(ast.f());
				continue;
			}
			if (ast._tag === "Union") {
				variants.push(...ast.types);
				continue;
			}
			if (ast._tag === "NeverKeyword") continue;
			const errorSchema = Schema.make(ast);
			it(`decodes declared error variant ${index} through JSON and the stub server`, async () => {
				let failure: unknown;
				await withClient(
					{
						[rpc._tag]: () => {
							throw failure;
						},
					},
					(call) =>
						fc.assert(
							fc.asyncProperty(
								payloads,
								values(errorSchema),
								async (payload, error) => {
									failure = error;
									const result = await call(rpc._tag, payload);
									expect(result._tag).toBe("Left");
									if (result._tag === "Failure") {
										expect(
											json(Schema.encodeSync(errorSchema)(result.failure)),
										).toEqual(json(Schema.encodeSync(errorSchema)(error)));
										if (typeof error === "object" && error !== null) {
											expect(result.failure).toBeInstanceOf(error.constructor);
										}
									}
								},
							),
							options,
						),
				);
			});
		}
	});
}
