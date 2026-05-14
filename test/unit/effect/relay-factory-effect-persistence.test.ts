import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { expect, vi } from "vitest";
import {
	HttpServerRefTag,
	RelayFactoryLive,
	RelayFactoryTag,
} from "../../../src/lib/domain/daemon/Layers/relay-factory-layer.js";
import {
	DaemonConfigRefLive,
	makeDaemonConfigFromOptions,
} from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";

const createProjectRelayMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/lib/relay/relay-stack.js", () => ({
	createProjectRelay: createProjectRelayMock,
}));

describe("RelayFactoryLive Effect persistence wiring", () => {
	it.effect(
		"creates relays with persistenceDbPath but no legacy PersistenceLayer",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-relay-factory-effect-"));
			const projectDir = join(dir, "project");
			const server = createServer();
			createProjectRelayMock.mockResolvedValue({
				stop: vi.fn(async () => undefined),
			});

			const layer = RelayFactoryLive(join(dir, "config")).pipe(
				Layer.provide(DaemonConfigRefLive(makeDaemonConfigFromOptions({}))),
			);

			return Effect.gen(function* () {
				const httpServerRef = yield* HttpServerRefTag;
				yield* Ref.set(httpServerRef, server);

				const factory = yield* RelayFactoryTag;
				yield* factory
					.create(
						{
							slug: "effect-project",
							title: "Effect Project",
							directory: projectDir,
						},
						"http://localhost:4096",
					)
					.pipe(Effect.scoped);

				expect(createProjectRelayMock).toHaveBeenCalledOnce();
				const config = createProjectRelayMock.mock.calls[0]?.[0];
				expect(config).toEqual(
					expect.objectContaining({
						persistenceDbPath: join(projectDir, ".conduit", "events.db"),
					}),
				);
				expect(config).not.toHaveProperty("persistence");
			}).pipe(
				Effect.provide(Layer.fresh(layer)),
				Effect.ensuring(
					Effect.sync(() => {
						server.close();
						rmSync(dir, { recursive: true, force: true });
						createProjectRelayMock.mockReset();
					}),
				),
			);
		},
	);
});
