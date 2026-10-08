// Full tool details, in memory only. Expanding a previewed tool and
// prefetching both come here. A finished tool's detail never changes, so it is
// kept by session and tool id (forks repeat call ids) within about 50 MB,
// least recently used out first. Only the server's word that a tool finished
// counts: the browser shows some running tools as completed. Asks for one
// session in the same tick share one GetToolDetails request, and an ask for a
// tool already on its way joins that request.

import {
	ToolCallId,
	type ToolDetail,
	Utf8Bytes,
} from "../../contracts/tool-wire.js";
import { getToolDetailsRpc } from "../transport/ws-rpc-client.js";
import type { ToolMessage } from "../types.js";
import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../ui-constants.js";

export interface SessionRef {
	readonly projectSlug: string;
	readonly sessionId: string;
}

/** A finished tool's detail: the only kind that may be kept. */
type SettledDetail = ToolDetail & { readonly settled: true };

const isSettled = (detail: ToolDetail): detail is SettledDetail =>
	detail.settled;

const KEPT_BYTES = Utf8Bytes.make(50_000_000);
const PREFETCH_BYTES_PER_VIEW = Utf8Bytes.make(5_000_000);

/** What a tool's full detail weighs: the full size of each field its preview cut. */
const fullBytes = ({ preview }: ToolMessage): number =>
	(preview?.resultBytes ?? 0) +
	(preview?.inputCuts ?? []).reduce((sum, cut) => sum + cut.fullBytes, 0);

const sessionKey = ({ projectSlug, sessionId }: SessionRef) =>
	`${projectSlug}\0${sessionId}`;

interface Waiter {
	readonly id: ToolCallId;
	readonly resolve: (detail: ToolDetail | undefined) => void;
	readonly reject: (error: unknown) => void;
}

export function makeToolDetails(
	fetchDetails: (
		session: SessionRef,
		toolIds: readonly [ToolCallId, ...ToolCallId[]],
	) => Promise<readonly ToolDetail[]>,
) {
	const kept = new Map<string, { detail: ToolDetail; bytes: number }>();
	let keptBytes = 0;
	const inFlight = new Map<string, Promise<ToolDetail | undefined>>();
	const batches = new Map<string, Waiter[]>();

	const keep = (key: string, tool: ToolMessage, detail: SettledDetail) => {
		const bytes = fullBytes(tool);
		if (bytes > KEPT_BYTES) return;
		keptBytes += bytes - (kept.get(key)?.bytes ?? 0);
		kept.delete(key);
		kept.set(key, { detail, bytes });
		for (const [oldest, entry] of kept) {
			if (keptBytes <= KEPT_BYTES) break;
			kept.delete(oldest);
			keptBytes -= entry.bytes;
		}
	};

	const send = (session: SessionRef, waiters: readonly Waiter[]) => {
		const [first, ...rest] = new Set(waiters.map(({ id }) => id));
		if (first === undefined) return;
		const timeout = setTimeout(() => {
			for (const waiter of waiters)
				waiter.reject(new Error("Tool details took too long"));
		}, TOOL_CONTENT_LOAD_TIMEOUT_MS);
		fetchDetails(session, [first, ...rest])
			.then(
				(tools) => {
					for (const waiter of waiters)
						waiter.resolve(tools.find(({ toolId }) => toolId === waiter.id));
				},
				(error: unknown) => {
					for (const waiter of waiters) waiter.reject(error);
				},
			)
			.finally(() => clearTimeout(timeout));
	};

	const request = (session: SessionRef, id: ToolCallId) =>
		new Promise<ToolDetail | undefined>((resolve, reject) => {
			const key = sessionKey(session);
			const batch = batches.get(key) ?? [];
			if (batch.length === 0) {
				batches.set(key, batch);
				setTimeout(() => {
					batches.delete(key);
					send(session, batch);
				}, 0);
			}
			batch.push({ id, resolve, reject });
		});

	const toolKey = (session: SessionRef, tool: ToolMessage) =>
		`${sessionKey(session)}\0${tool.id}`;
	// A request sent before the tool moved on answers for its old state, so an
	// ask joins only a request sent for the same status.
	const flightKey = (session: SessionRef, tool: ToolMessage) =>
		`${toolKey(session, tool)}\0${tool.status}`;

	/** This tool's full detail; undefined when the server has no such tool. */
	const get = (
		session: SessionRef,
		tool: ToolMessage,
	): Promise<ToolDetail | undefined> => {
		const key = toolKey(session, tool);
		const hit = kept.get(key);
		if (hit) {
			kept.delete(key);
			kept.set(key, hit);
			return Promise.resolve(hit.detail);
		}
		const flight = flightKey(session, tool);
		const flying = inFlight.get(flight);
		if (flying) return flying;
		const loading = request(session, ToolCallId.make(tool.id))
			.then((detail) => {
				if (detail && isSettled(detail)) keep(key, tool, detail);
				return detail;
			})
			.finally(() => inFlight.delete(flight));
		inFlight.set(flight, loading);
		return loading;
	};

	let prefetching = false;
	let wanted:
		| { session: SessionRef; tools: readonly ToolMessage[] }
		| undefined;
	let view: string | undefined;
	let spent = 0;

	const prefetch = () => {
		const next = wanted;
		wanted = undefined;
		if (!next) return;
		if (sessionKey(next.session) !== view) {
			view = sessionKey(next.session);
			spent = 0;
		}
		const chosen = next.tools.filter((tool) => {
			const bytes = fullBytes(tool);
			if (
				(tool.status !== "completed" && tool.status !== "error") ||
				bytes === 0 ||
				spent + bytes > PREFETCH_BYTES_PER_VIEW ||
				kept.has(toolKey(next.session, tool)) ||
				inFlight.has(flightKey(next.session, tool))
			)
				return false;
			spent += bytes;
			return true;
		});
		if (chosen.length === 0) return;
		prefetching = true;
		void Promise.allSettled(chosen.map((tool) => get(next.session, tool))).then(
			() => {
				prefetching = false;
				prefetch();
			},
		);
	};

	/**
	 * These tools are wanted soon: load the cut, settled ones in the
	 * background. One prefetch runs at a time and the newest wanted set waits
	 * for it; each session view stops after about 5 MB. Failures are silent and
	 * not retried.
	 */
	const wantSoon = (session: SessionRef, tools: readonly ToolMessage[]) => {
		wanted = { session, tools };
		if (!prefetching) prefetch();
	};

	return { get, wantSoon };
}

export const toolDetails = makeToolDetails(
	async (session, toolIds) =>
		(await getToolDetailsRpc({ ...session, toolIds })).tools,
);
