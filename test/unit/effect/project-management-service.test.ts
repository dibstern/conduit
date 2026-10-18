import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import {
	ProjectManagementServiceLive,
	ProjectManagementServiceTag,
} from "../../../src/lib/domain/relay/Services/project-management-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import { makeMockConfig } from "../../helpers/mock-factories.js";

describe("standalone ProjectManagementServiceLive", () => {
	const layer = ProjectManagementServiceLive.pipe(
		Layer.provide(
			Layer.succeed(ConfigTag)(makeMockConfig({ slug: "standalone" })),
		),
	);

	it.effect("starts with local config and lists no daemon projects", () =>
		Effect.gen(function* () {
			const service = yield* ProjectManagementServiceTag;
			expect(yield* service.currentSlug()).toBe("standalone");
			expect(yield* service.list()).toEqual([]);
		}).pipe(Effect.provide(layer)),
	);

	it.effect("retains unsupported save and remove errors", () =>
		Effect.gen(function* () {
			const service = yield* ProjectManagementServiceTag;
			expect(
				yield* Effect.result(service.save({ folders: ["/work/new"] })),
			).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "ProjectManagementNotSupported",
					operation: "save",
					message: "Saving projects is not supported in this mode",
				},
			});
			expect(yield* Effect.result(service.remove("missing"))).toMatchObject({
				_tag: "Failure",
				failure: {
					_tag: "ProjectManagementNotSupported",
					operation: "remove",
					message: "Removing projects is not supported in this mode",
				},
			});
		}).pipe(Effect.provide(layer)),
	);
});
