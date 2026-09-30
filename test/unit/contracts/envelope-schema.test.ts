import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import { EnvelopeSchema } from "../../../src/lib/contracts/ws-rpc.js";
import type { Envelope } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { EnvelopeSchema as FrontendEnvelopeSchema } from "../../../src/lib/frontend/transport/ws-rpc.js";

describe("subscription envelope contract", () => {
	it("decodes each variant with the supplied item schema", () => {
		const schema = EnvelopeSchema(Schema.NumberFromString);
		const decode = Schema.decodeUnknownSync(schema);
		expect(decode({ _tag: "snapshot", rows: ["7"], sequence: 10 })).toEqual({
			_tag: "snapshot",
			rows: [7],
			sequence: 10,
		});
		expect(decode({ _tag: "synchronized" })).toEqual({ _tag: "synchronized" });
		expect(decode({ _tag: "upsert", item: "8", sequence: 11 })).toEqual({
			_tag: "upsert",
			item: 8,
			sequence: 11,
		});
		expect(decode({ _tag: "remove", id: "row-1", sequence: 12 })).toEqual({
			_tag: "remove",
			id: "row-1",
			sequence: 12,
		});
		expectTypeOf<Envelope<number>>().toEqualTypeOf<
			Schema.Schema.Type<typeof schema>
		>();
		expect(FrontendEnvelopeSchema).toBe(EnvelopeSchema);
	});
});
