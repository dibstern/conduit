import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	type ScanService,
	ScanServiceError,
	ScanServiceNotAvailable,
	ScanServiceTag,
} from "../../../src/lib/effect/scan-service.js";
import { WebSocketHandlerTag } from "../../../src/lib/effect/services.js";
import { handleScanNow } from "../../../src/lib/handlers/instance.js";
import { makeMockWebSocketHandler } from "../../helpers/mock-factories.js";

const makeService = (overrides: Partial<ScanService> = {}): ScanService => ({
	scanNow: vi.fn(() =>
		Effect.succeed({
			discovered: [8080],
			lost: [],
			active: [3000, 8080],
		}),
	),
	...overrides,
});

describe("scan handler through ScanService", () => {
	it.effect("sends scan results through the service", () => {
		const wsHandler = makeMockWebSocketHandler();
		const service = makeService();
		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, wsHandler),
			Layer.succeed(ScanServiceTag, service),
		);

		return handleScanNow("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(service.scanNow).toHaveBeenCalledOnce();
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "scan_result",
					discovered: [8080],
					lost: [],
					active: [3000, 8080],
				});
			}),
		);
	});

	it.effect("keeps the unavailable-service error envelope stable", () => {
		const wsHandler = makeMockWebSocketHandler();
		const layer = Layer.succeed(WebSocketHandlerTag, wsHandler);

		return handleScanNow("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "Port scanning not available",
				});
			}),
		);
	});

	it.effect("renders typed unavailable errors with the stable message", () => {
		const wsHandler = makeMockWebSocketHandler();
		const service = makeService({
			scanNow: vi.fn(() =>
				Effect.fail(
					new ScanServiceNotAvailable({
						message: "Port scanning not available",
					}),
				),
			),
		});
		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, wsHandler),
			Layer.succeed(ScanServiceTag, service),
		);

		return handleScanNow("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "Port scanning not available",
				});
			}),
		);
	});

	it.effect("renders scan failures as instance errors", () => {
		const wsHandler = makeMockWebSocketHandler();
		const service = makeService({
			scanNow: vi.fn(() =>
				Effect.fail(
					new ScanServiceError({
						cause: new Error("scanner failed"),
					}),
				),
			),
		});
		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, wsHandler),
			Layer.succeed(ScanServiceTag, service),
		);

		return handleScanNow("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "scanner failed",
				});
			}),
		);
	});
});
