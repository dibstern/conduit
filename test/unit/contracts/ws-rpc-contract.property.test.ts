import {
	Arbitrary,
	Effect,
	Exit,
	type Result,
	Schema,
	type SchemaAST,
	Stream,
} from "effect";
import { RpcSchema } from "effect/rpc";
import { describe, expect, it } from "vitest";
import { WsRpcGroup, WsRpcRequest } from "../../../src/lib/contracts/ws-rpc.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";

const options = { seed: 42, runs: 30, maxShrinks: 0 };
const json = (value: unknown): unknown =>
	value === undefined ? undefined : JSON.parse(JSON.stringify(value));

// Generate the wire side, then decode so transformed requests have canonical
// account references and tagged errors are instances of their declared class.
const values = <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
	Arbitrary.schema(Schema.toEncoded(schema)).pipe(
		Arbitrary.filter((value) =>
			Exit.isSuccess(Schema.decodeUnknownExit(schema)(json(value))),
		),
		Arbitrary.map((value) => Schema.decodeUnknownSync(schema)(json(value))),
	);

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
		) => Promise<Result.Result<unknown, unknown>>,
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
	const payloadSchema = rpc.payloadSchema;
	// Some request transforms canonicalize legacy account-selection fields.
	// Generate their normal form, then require the next wire round trip to preserve it.
	const payloads = values(payloadSchema).pipe(
		Arbitrary.map((payload) =>
			Schema.decodeUnknownSync(payloadSchema)(
				json(Schema.encodeSync(payloadSchema)(payload)),
			),
		),
	);
	const stream = RpcSchema.isStreamSchema(rpc.successSchema)
		? rpc.successSchema
		: undefined;
	const successSchema = stream?.success ?? rpc.successSchema;

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
					Effect.runPromise(
						Arbitrary.checkEffect(
							Arbitrary.all([
								payloads,
								Arbitrary.array(values(successSchema), {
									minLength: stream ? 0 : 1,
									maxLength: stream ? 5 : 1,
								}),
							]),
							([payload, success]) =>
								Effect.promise(async () => {
									const encodedPayload = json(
										Schema.encodeSync(payloadSchema)(payload),
									);
									reply = success;
									const result = await call(rpc._tag, payload);
									expect(received).toEqual(payload);
									expect(
										json(Schema.encodeUnknownSync(payloadSchema)(received)),
									).toEqual(encodedPayload);
									expect(result._tag).toBe("Success");
									if (result._tag === "Success") {
										expect(result.success).toEqual(
											stream ? success : success[0],
										);
									}
									if (!stream) {
										expect(
											Schema.decodeUnknownSync(WsRpcRequest)(encodedPayload),
										).toEqual(payload);
									}
									return true;
								}),
							options,
						),
					).then((result) => {
						expect(result._tag).toBe("Passed");
					}),
			);
		});

		const variants: SchemaAST.AST[] = [rpc.errorSchema.ast];
		if (stream) variants.push(stream.error.ast);
		for (const [index, ast] of variants.entries()) {
			if (ast._tag === "Suspend") {
				variants.push(ast.thunk());
				continue;
			}
			if (ast._tag === "Union") {
				variants.push(...ast.types);
				continue;
			}
			if (ast._tag === "Never") continue;
			const errorSchema = Schema.make<Schema.Codec<unknown, unknown>>(ast);
			it(`decodes declared error variant ${index} through JSON and the stub server`, async () => {
				let failure: unknown;
				await withClient(
					{
						[rpc._tag]: () => {
							throw failure;
						},
					},
					(call) =>
						Effect.runPromise(
							Arbitrary.checkEffect(
								Arbitrary.all([payloads, values(errorSchema)]),
								([payload, error]) =>
									Effect.promise(async () => {
										failure = error;
										const result = await call(rpc._tag, payload);
										expect(result._tag).toBe("Failure");
										if (result._tag === "Failure") {
											expect(
												json(Schema.encodeSync(errorSchema)(result.failure)),
											).toEqual(json(Schema.encodeSync(errorSchema)(error)));
											if (typeof error === "object" && error !== null) {
												expect(result.failure).toBeInstanceOf(
													error.constructor,
												);
											}
										}
										return true;
									}),
								options,
							),
						).then((result) => {
							expect(result._tag).toBe("Passed");
						}),
				);
			});
		}
	});
}
