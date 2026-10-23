import { Effect, Schema } from "effect";
import { Rpc, type RpcGroup } from "effect/rpc";
import { expectTypeOf, it } from "vitest";
import type { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type SubscriptionAudienceTable,
	subscriptionAudiences,
} from "../../../src/lib/server/event-delivery.js";

it("EA25 every subscribe method requires an audience entry", () => {
	const added = Rpc.make("SubscribeAdded", {
		payload: { projectSlug: Schema.String },
		success: Schema.String,
		stream: true,
	});
	type Expanded = RpcGroup.Rpcs<typeof WsRpcGroup> | typeof added;
	// @ts-expect-error The new stream cannot inherit a default audience.
	const incomplete: SubscriptionAudienceTable<Expanded> = subscriptionAudiences;
	const complete: SubscriptionAudienceTable<Expanded> = {
		...subscriptionAudiences,
		SubscribeAdded: (request, producer) => {
			expectTypeOf(request.projectSlug).toEqualTypeOf<string>();
			return Effect.succeed({ _tag: "project", projectId: producer.projectId });
		},
	};
	expectTypeOf(complete).toExtend<SubscriptionAudienceTable<Expanded>>();
	void incomplete;
});
