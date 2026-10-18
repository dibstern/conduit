import { existsSync, readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { SessionDetailEnvelopeSchema } from "../../../src/lib/contracts/ws-rpc.js";
import type { ReadModelRead } from "../../../src/lib/domain/relay/Services/read-model-subscription.js";
import { expect } from "./process-harness-fixture.js";

/** Match nested RPC requests and chunks without depending on frame batching. */
export const find = (
	value: unknown,
	match: (value: object) => boolean,
): object[] => {
	if (typeof value !== "object" || value === null) return [];
	const nested = Object.values(value).flatMap((child) => find(child, match));
	return match(value) ? [value, ...nested] : nested;
};

const parse = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

/** Record a page's detail subscriptions, their envelopes and page diagnostics. */
export const observeDetail = (
	page: Page,
	metricsFile: string,
	sessionId: string,
) => {
	const sent: unknown[] = [];
	const received: unknown[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => sent.push(parse(String(payload))));
		socket.on("framereceived", ({ payload }) =>
			received.push(parse(String(payload))),
		);
	});
	const mismatches: string[] = [];
	page.on("console", (message) => {
		if (message.text().includes("[resume] checksum mismatch"))
			mismatches.push(message.text());
	});
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	const requests = (sessionId: string, from = 0) =>
		sent
			.slice(from)
			.flatMap((value) =>
				find(
					value,
					(found) =>
						"_tag" in found &&
						found._tag === "Request" &&
						"tag" in found &&
						found.tag === "SubscribeSessionDetail" &&
						"payload" in found &&
						typeof found.payload === "object" &&
						found.payload !== null &&
						"sessionId" in found.payload &&
						found.payload.sessionId === sessionId,
				),
			);
	const envelopes = (sessionId: string, sentFrom = 0, receivedFrom = 0) => {
		const ids = new Set(
			requests(sessionId, sentFrom).map((request) =>
				"id" in request ? String(request.id) : "",
			),
		);
		return received
			.slice(receivedFrom)
			.flatMap((value) =>
				find(
					value,
					(found) =>
						"_tag" in found &&
						found._tag === "Chunk" &&
						"requestId" in found &&
						ids.has(String(found.requestId)),
				),
			)
			.flatMap((chunk) => {
				const values: readonly unknown[] =
					"values" in chunk && Array.isArray(chunk.values) ? chunk.values : [];
				return values.filter(Schema.is(SessionDetailEnvelopeSchema));
			});
	};
	// The process harness subscribes to conduit:read-model-read and flushes
	// source counts atomically every 250ms. Wait for a flush beyond each phase.
	const detailReads = async () => {
		const asked = Date.now();
		await expect.poll(() => existsSync(metricsFile)).toBe(true);
		const metrics = () =>
			JSON.parse(readFileSync(metricsFile, "utf8")) as {
				flushedAt: number;
				sources: Record<
					string,
					{ reads: Partial<Record<ReadModelRead["kind"], number>> }
				>;
			};
		await expect.poll(() => metrics().flushedAt).toBeGreaterThan(asked);
		return metrics().sources[`session-detail/${sessionId}`]?.reads ?? {};
	};
	return {
		sent,
		received,
		mismatches,
		pageErrors,
		requests,
		envelopes,
		detailReads,
	};
};
