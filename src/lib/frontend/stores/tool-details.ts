// Full tool details, in memory only. Expanding a previewed tool and
// prefetching both come here. A finished tool's detail never changes, so it is
// kept by session and tool id (forks repeat call ids) within about 50 MB,
// least recently used out first. Only the server's word that a tool finished
// counts: the browser shows some running tools as completed. Every finished
// detail a reply carries is kept, even one that arrives after its asker gave
// up. Asks for one session in the same tick share one GetToolDetails request,
// and an ask for a tool already on its way joins that request. Prefetch waits
// for the session's first load and spends about 5 MB per view of it.

import {
	ToolCallId,
	type ToolDetail,
	Utf8Bytes,
} from "../../contracts/tool-wire.js";
import { rpc } from "../transport/ws-rpc-client.js";
import type { ToolMessage } from "../types.js";
import { TOOL_CONTENT_LOAD_TIMEOUT_MS } from "../ui-constants.js";
import { toolCommand } from "../utils/turns.js";
import { sessionViewLoaded } from "./transcript.svelte.js";

export interface SessionRef {
	readonly projectSlug: string;
	readonly sessionId: string;
}

/** A finished tool's detail: the only kind that may be kept. */
type SettledDetail = ToolDetail & { readonly settled: true };

const isSettled = (detail: ToolDetail): detail is SettledDetail =>
	detail.settled;

/** In UTF-16 code units, which is about bytes for the mostly ASCII text tools return. */
const KEPT_SIZE = 50_000_000;
const PREFETCH_BYTES_PER_VIEW = Utf8Bytes.make(5_000_000);

/** What a kept detail weighs: its size as JSON, output measured without copying it. */
const weight = ({ output, ...rest }: ToolDetail): number =>
	JSON.stringify(rest).length + (output?.text.length ?? 0);

/** What a prefetch will download: the full size of each field the preview cut. */
const fullBytes = ({ preview }: ToolMessage): number =>
	(preview?.resultBytes ?? 0) +
	(preview?.inputCuts ?? []).reduce((sum, cut) => sum + cut.fullBytes, 0);

/**
 * What of a cut tool the cards show: its result and a shell command. A cut
 * elsewhere in the input (a written file's content) is nothing to load.
 */
export const shownCut = (
	tool: ToolMessage,
): "command and output" | "output" | "command" | undefined => {
	const output = tool.preview?.resultBytes !== undefined;
	const command =
		toolCommand(tool) !== undefined &&
		(tool.preview?.inputCuts ?? []).some(
			({ path }) => path.length === 1 && path[0] === "command",
		);
	if (output && command) return "command and output";
	if (output) return "output";
	return command ? "command" : undefined;
};

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
	/**
	 * This session's view while it is open: the same promise throughout,
	 * settling true once its first load completes and false if it is left
	 * first.
	 */
	viewLoaded: (session: SessionRef) => Promise<boolean> | undefined,
) {
	const kept = new Map<string, { detail: SettledDetail; size: number }>();
	let keptSize = 0;
	const inFlight = new Map<string, Promise<ToolDetail | undefined>>();
	const batches = new Map<string, Waiter[]>();

	const toolKey = (session: SessionRef, id: string) =>
		`${sessionKey(session)}\0${id}`;

	const keep = (key: string, detail: SettledDetail) => {
		const size = weight(detail);
		if (size > KEPT_SIZE) return;
		keptSize += size - (kept.get(key)?.size ?? 0);
		kept.delete(key);
		kept.set(key, { detail, size });
		for (const [oldest, entry] of kept) {
			if (keptSize <= KEPT_SIZE) break;
			kept.delete(oldest);
			keptSize -= entry.size;
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
					for (const detail of tools)
						if (isSettled(detail))
							keep(toolKey(session, detail.toolId), detail);
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

	// A request sent before the tool moved on answers for its old state, so an
	// ask joins only a request sent for the same status.
	const flightKey = (session: SessionRef, tool: ToolMessage) =>
		`${toolKey(session, tool.id)}\0${tool.status}`;

	/** This tool's full detail; undefined when the server has no such tool. */
	const get = (
		session: SessionRef,
		tool: ToolMessage,
	): Promise<ToolDetail | undefined> => {
		const key = toolKey(session, tool.id);
		const hit = kept.get(key);
		if (hit) {
			kept.delete(key);
			kept.set(key, hit);
			return Promise.resolve(hit.detail);
		}
		const flight = flightKey(session, tool);
		const flying = inFlight.get(flight);
		if (flying) return flying;
		const loading = request(session, ToolCallId.make(tool.id)).finally(() =>
			inFlight.delete(flight),
		);
		inFlight.set(flight, loading);
		return loading;
	};

	let prefetching = false;
	/** Every tool wanted for one view since the last prefetch, by id. */
	let wanted:
		| {
				view: Promise<boolean>;
				session: SessionRef;
				tools: Map<string, ToolMessage>;
		  }
		| undefined;
	let budget: { view: Promise<boolean>; spent: number } | undefined;

	const prefetch = async () => {
		if (prefetching) return;
		prefetching = true;
		try {
			while (wanted) {
				const next = wanted;
				const loaded = await next.view;
				// Another view's set replaced this one while it loaded: it was left.
				if (wanted !== next) continue;
				wanted = undefined;
				if (!loaded) continue;
				if (budget?.view !== next.view) budget = { view: next.view, spent: 0 };
				const view = budget;
				const chosen = [...next.tools.values()].filter((tool) => {
					const bytes = fullBytes(tool);
					if (
						(tool.status !== "completed" && tool.status !== "error") ||
						shownCut(tool) === undefined ||
						view.spent + bytes > PREFETCH_BYTES_PER_VIEW ||
						kept.has(toolKey(next.session, tool.id)) ||
						inFlight.has(flightKey(next.session, tool))
					)
						return false;
					view.spent += bytes;
					return true;
				});
				await Promise.allSettled(chosen.map((tool) => get(next.session, tool)));
			}
		} finally {
			prefetching = false;
		}
	};

	/**
	 * These tools are wanted soon: once the session's first load completes,
	 * load the settled ones whose cut a card shows. One prefetch runs at a
	 * time; sets wanted for the same view meanwhile join into the next one.
	 * Each view of a session stops after about 5 MB. Failures are silent and
	 * not retried.
	 */
	const wantSoon = (session: SessionRef, tools: readonly ToolMessage[]) => {
		const view = viewLoaded(session);
		if (!view) return;
		if (wanted?.view !== view) wanted = { view, session, tools: new Map() };
		for (const tool of tools) wanted.tools.set(tool.id, tool);
		prefetch().catch((error: unknown) =>
			console.warn("Tool prefetch failed", error),
		);
	};

	return { get, wantSoon };
}

export const toolDetails = makeToolDetails(
	async (session, toolIds) =>
		(await rpc("GetToolDetails", { ...session, toolIds })).tools,
	({ projectSlug, sessionId }) => sessionViewLoaded(projectSlug, sessionId),
);
