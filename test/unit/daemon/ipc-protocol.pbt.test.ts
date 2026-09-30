import { Either, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IpcTaggedRequestSchema } from "../../../src/lib/contracts/ipc-requests.js";
import { serializeResponse } from "../../../src/lib/daemon/ipc-protocol.js";
import type { IPCResponse } from "../../../src/lib/types.js";
import { generateSlug } from "../../../src/lib/utils.js";
import {
	directoryPath,
	edgeCaseString,
	invalidIpcRequest,
	validIpcRequest,
} from "../../helpers/arbitraries.js";

const options = { seed: 42, numRuns: 300, endOnFailure: true };
const decode = Schema.decodeUnknownEither(IpcTaggedRequestSchema);

describe("Tagged IPC protocol properties", () => {
	it("roundtrips schema-encoded tagged requests", () => {
		fc.assert(
			fc.property(validIpcRequest, (request) => {
				const encoded = Schema.encodeSync(IpcTaggedRequestSchema)(request);
				const decoded = decode(JSON.parse(JSON.stringify(encoded)));
				expect(Either.isRight(decoded)).toBe(true);
				if (Either.isRight(decoded)) expect(decoded.right).toEqual(request);
			}),
			options,
		);
	});

	it("rejects unknown tags and invalid fields", () => {
		fc.assert(
			fc.property(invalidIpcRequest, (request) => {
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

	it("serializes responses as JSON lines without changing their fields", () => {
		const responses: fc.Arbitrary<IPCResponse> = fc.oneof(
			fc.record({ ok: fc.constant(true) }),
			fc.record({ ok: fc.constant(false), error: fc.string() }),
			fc.record({ ok: fc.constant(true), slug: fc.string() }),
		);
		fc.assert(
			fc.property(responses, (response) => {
				const wire = serializeResponse(response);
				expect(wire.endsWith("\n")).toBe(true);
				expect(JSON.parse(wire)).toEqual(response);
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
		{ _tag: "InstanceAdd", name: "work", managed: true },
		{ _tag: "InstanceAdd", name: "work", managed: true, port: 0 },
		{ _tag: "InstanceAdd", name: "work", managed: true, port: 65536 },
		{
			_tag: "InstanceAdd",
			name: "work",
			managed: true,
			port: 4096,
			url: "http://host:4096",
		},
		{ _tag: "InstanceAdd", name: "work", managed: false },
		{ _tag: "InstanceAdd", name: "work", managed: false, url: "" },
		{ _tag: "InstanceAdd", name: "work", managed: false, url: "not-a-url" },
		{ _tag: "InstanceAdd", name: "work", managed: false, url: 42 },
		{ _tag: "InstanceAdd", name: "", managed: true, port: 4096 },
		{ _tag: "InstanceAdd", name: "work", managed: "yes", port: 4096 },
		{ _tag: "InstanceAdd", name: "work", managed: true, driver: "claude" },
		{
			_tag: "InstanceAdd",
			name: "work",
			managed: false,
			driver: "claude",
			port: 4096,
		},
		{
			_tag: "InstanceAdd",
			name: "work",
			managed: false,
			driver: "claude",
			url: "http://host:4096",
		},
	])("rejects invalid instance addition %#", (request) => {
		expect(Either.isLeft(decode(request))).toBe(true);
	});

	it.each([
		"InstanceRemove",
		"InstanceStart",
		"InstanceStop",
		"InstanceStatus",
		"InstanceUpdate",
	])("requires a non-empty id for %s", (_tag) => {
		for (const id of [undefined, ""]) {
			expect(Either.isLeft(decode({ _tag, id }))).toBe(true);
		}
	});

	describe("slug generation sanitization", () => {
		// Tests the pattern used by InstanceAdd IPC handlers.
		function slugify(name: string): string {
			return (
				name
					.toLowerCase()
					.replace(/[^a-z0-9-]/g, "-")
					.replace(/-+/g, "-")
					.replace(/^-|-$/g, "") || "instance"
			);
		}

		it("produces clean slug from normal name", () => {
			expect(slugify("My Work")).toBe("my-work");
		});

		it("collapses consecutive dashes", () => {
			expect(slugify("a---b")).toBe("a-b");
			expect(slugify("test!!name")).toBe("test-name");
		});

		it("trims leading and trailing dashes", () => {
			expect(slugify("--test--")).toBe("test");
			expect(slugify("!hello!")).toBe("hello");
		});

		it("falls back to 'instance' for empty result", () => {
			expect(slugify("!!!")).toBe("instance");
			expect(slugify("")).toBe("instance");
		});

		it("handles unicode names", () => {
			expect(slugify("café")).toBe("caf");
			// Entirely non-ascii
			expect(slugify("日本語")).toBe("instance");
		});
	});
});
