import { Either, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WsRpcRequest } from "../../../src/lib/contracts/ws-rpc.js";
import { generateSlug } from "../../../src/lib/utils.js";
import {
	directoryPath,
	edgeCaseString,
	invalidDaemonRpcRequest,
	validDaemonRpcRequest,
} from "../../helpers/arbitraries.js";

const options = { seed: 42, numRuns: 300, endOnFailure: true };
const decode = Schema.decodeUnknownEither(WsRpcRequest);

describe("Daemon RPC request properties", () => {
	it("roundtrips schema-encoded tagged requests", () => {
		fc.assert(
			fc.property(validDaemonRpcRequest, (request) => {
				const encoded = Schema.encodeSync(WsRpcRequest)(request);
				const decoded = decode(JSON.parse(JSON.stringify(encoded)));
				expect(Either.isRight(decoded)).toBe(true);
				if (Either.isRight(decoded)) expect(decoded.right).toEqual(request);
			}),
			options,
		);
	});

	it("rejects unknown tags and invalid fields", () => {
		fc.assert(
			fc.property(invalidDaemonRpcRequest, (request) => {
				expect(Either.isLeft(decode(request))).toBe(true);
			}),
			options,
		);
	});

	it("never throws when decoding arbitrary input", () => {
		fc.assert(
			fc.property(edgeCaseString, (value) => {
				expect(() => decode(value)).not.toThrow();
			}),
			options,
		);
	});

	it("generates non-empty, lowercase, unique project slugs", () => {
		fc.assert(
			fc.property(
				directoryPath,
				fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 10 }),
				(directory, used) => {
					const existing = new Set(used);
					const slug = generateSlug(directory, existing);
					expect(slug).toMatch(/^[a-z0-9-]+$/);
					expect(existing.has(slug)).toBe(false);
				},
			),
			options,
		);
	});

	it("generates distinct slugs when adding a directory repeatedly", () => {
		fc.assert(
			fc.property(
				directoryPath,
				fc.integer({ min: 2, max: 20 }),
				(directory, count) => {
					const slugs = new Set<string>();
					for (let i = 0; i < count; i++) {
						const slug = generateSlug(directory, slugs);
						expect(slugs.has(slug)).toBe(false);
						slugs.add(slug);
					}
					expect(slugs.size).toBe(count);
				},
			),
			options,
		);
	});

	it("preserves restart configuration overrides", () => {
		const result = decode({
			_tag: "RestartWithConfig",
			config: { tls: true, port: 2634 },
		});
		expect(Either.isRight(result)).toBe(true);
		if (Either.isRight(result) && result.right._tag === "RestartWithConfig") {
			expect(result.right.config).toEqual({ tls: true, port: 2634 });
		}
	});

	it.each([
		{ _tag: "AddInstance", name: "work", url: 42 },
		{ _tag: "AddInstance", name: "", managed: true, port: 4096 },
		{ _tag: "AddInstance", name: "work", managed: "yes", port: 4096 },
		{ _tag: "AddInstance", name: "work", driver: 42 },
	])("rejects invalid instance addition %#", (request) => {
		expect(Either.isLeft(decode(request))).toBe(true);
	});

	it.each([
		"RemoveInstance",
		"StartInstance",
		"StopInstance",
		"GetInstanceStatus",
		"UpdateInstance",
	])("requires a non-empty id for %s", (_tag) => {
		for (const instanceId of [undefined, ""]) {
			expect(Either.isLeft(decode({ _tag, instanceId }))).toBe(true);
		}
	});
});
