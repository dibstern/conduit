// ─── Subagent Fixture Capture ─────────────────────────────────────────────
// Captures real OpenCode session data for subagent E2E tests.
// Connects to a running OpenCode instance, finds a parent/child session pair,
// normalizes the data (stable IDs/timestamps), and writes a snapshot fixture
// that Playwright E2E tests import as mock data.
//
// Run:  pnpm test:contract -- subagent-fixture
// Update snapshot:  pnpm test:contract -- subagent-fixture --update

import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { apiGet, checkServerHealth } from "./helpers/server-connection.js";
import { getSessionMessages } from "./helpers/session-helpers.js";

// ─── Types (mirrors OpenCode REST shapes) ────────────────────────────────

interface OpenCodeSession {
	id: string;
	title?: string;
	parentID?: string;
	time?: { created?: number; updated?: number };
	[key: string]: unknown;
}

interface OpenCodeMessage {
	id?: string;
	role?: string;
	sessionID?: string;
	parts?: OpenCodePart[];
	cost?: number;
	tokens?: Record<string, unknown>;
	time?: Record<string, unknown>;
	// OpenCode may wrap as { info: ..., parts: ... }
	info?: Record<string, unknown>;
	[key: string]: unknown;
}

interface OpenCodePart {
	id?: string;
	type?: string;
	tool?: string;
	callID?: string;
	state?: {
		status?: string;
		input?: Record<string, unknown>;
		output?: string;
		metadata?: Record<string, unknown>;
		time?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

// ─── Normalization ───────────────────────────────────────────────────────

const BASE_TS = 1710000000000; // stable base timestamp
const TS_STEP = 1000; // 1 second between events

/**
 * Normalize a raw OpenCode message into the relay HistoryMessage shape
 * with stable IDs and timestamps.
 */
function normalizeMessage(
	raw: OpenCodeMessage,
	index: number,
	idMap: Map<string, string>,
	prefix: string,
): Record<string, unknown> {
	// Handle wrapped { info, parts } format
	const info = raw.info ?? raw;
	const parts =
		raw.parts ??
		(raw.info ? (raw as unknown as { parts: unknown[] }).parts : undefined);

	const role = (info["role"] as string) ?? "user";
	const stableId = `${prefix}-msg-${role}-${index + 1}`;
	const origId = (info["id"] as string) ?? stableId;
	idMap.set(origId, stableId);

	const result: Record<string, unknown> = {
		id: stableId,
		role,
		time: { created: BASE_TS / 1000 + index * TS_STEP },
	};

	if (role === "assistant") {
		result["time"] = {
			created: BASE_TS / 1000 + index * TS_STEP,
			completed: BASE_TS / 1000 + (index + 1) * TS_STEP,
		};
		if (info["cost"] != null) result["cost"] = info["cost"];
		if (info["tokens"] != null) result["tokens"] = info["tokens"];
	}

	if (Array.isArray(parts) && parts.length > 0) {
		result["parts"] = (parts as OpenCodePart[]).map(
			(p: OpenCodePart, pi: number) =>
				normalizePart(p, `${stableId}-part-${pi + 1}`, idMap),
		);
	}

	return result;
}

function normalizePart(
	raw: OpenCodePart,
	stableId: string,
	idMap: Map<string, string>,
): Record<string, unknown> {
	const part: Record<string, unknown> = {
		id: stableId,
		type: raw.type ?? "text",
	};

	if (raw.type === "text" || (!raw.type && raw["text"])) {
		// Text part — include content
		const text = (raw["text"] as string) ?? (raw["content"] as string) ?? "";
		part["text"] = text.length > 500 ? `${text.slice(0, 500)}…` : text;
	}

	if (raw.type === "tool" && raw.state) {
		part["tool"] = raw.tool ?? "unknown";
		part["callID"] = raw.callID ?? stableId;

		const state: Record<string, unknown> = {
			status: raw.state.status ?? "completed",
		};

		if (raw.state.input) {
			state["input"] = raw.state.input;
		}

		if (raw.state.output != null) {
			let output = raw.state.output;
			// Remap session IDs in task output (task_id: ses_xxx → ses_child001)
			for (const [orig, stable] of idMap) {
				output = output.replaceAll(orig, stable);
			}
			state["output"] =
				output.length > 500 ? `${output.slice(0, 500)}…` : output;
		}

		if (raw.state.metadata) {
			const meta = { ...raw.state.metadata };
			// Remap sessionId in metadata
			if (
				typeof meta["sessionId"] === "string" &&
				idMap.has(meta["sessionId"])
			) {
				meta["sessionId"] = idMap.get(meta["sessionId"]);
			}
			state["metadata"] = meta;
		}

		if (raw.state.time) {
			state["time"] = raw.state.time;
		}

		part["state"] = state;
	}

	return part;
}

// ─── Snapshot structure ──────────────────────────────────────────────────

interface SubagentSnapshot {
	parentSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
	};
	childSession: {
		id: string;
		title: string;
		updatedAt: number;
		messageCount: number;
		parentID: string;
	};
	parentHistory: {
		messages: Record<string, unknown>[];
		hasMore: boolean;
		total: number;
	};
	childHistory: {
		messages: Record<string, unknown>[];
		hasMore: boolean;
		total: number;
	};
}

// ─── Test ────────────────────────────────────────────────────────────────

const SNAPSHOT_PATH = resolve(
	import.meta.dirname ?? __dirname,
	"../e2e/fixtures/subagent-snapshot.json",
);

let serverAvailable = false;

beforeAll(async () => {
	const health = await checkServerHealth();
	serverAvailable = health?.healthy === true;
	if (!serverAvailable) {
		console.warn(
			"⚠️  OpenCode server not running — subagent fixture capture skipped",
		);
	}
});

describe("Subagent fixture capture", () => {
	it("captures and normalizes a parent/child session pair", async () => {
		if (!serverAvailable) {
			console.warn("SKIP: No OpenCode server — snapshot not updated");
			return;
		}

		// 1. List all sessions
		const allSessions = await apiGet<OpenCodeSession[]>("/session");
		const sessions = Array.isArray(allSessions)
			? allSessions
			: Object.values(allSessions as Record<string, OpenCodeSession>);

		// 2. Find a session with parentID (subagent/child session)
		const childRaw = sessions.find((s) => s.parentID);
		if (!childRaw) {
			console.warn(
				"SKIP: No subagent sessions found in OpenCode. " +
					"Create one by using the Task tool, then re-run.",
			);
			return;
		}

		const parentRaw = sessions.find((s) => s.id === childRaw.parentID);
		expect(parentRaw).toBeDefined();
		if (!parentRaw) return; // for TS narrowing

		// 3. Build stable ID map
		const idMap = new Map<string, string>();
		idMap.set(parentRaw.id, "ses_parent001");
		idMap.set(childRaw.id, "ses_child001");

		// 4. Fetch histories
		const parentMsgs = (await getSessionMessages(
			parentRaw.id,
		)) as OpenCodeMessage[];
		const childMsgs = (await getSessionMessages(
			childRaw.id,
		)) as OpenCodeMessage[];

		// 5. Normalize
		const parentHistory = parentMsgs.map((m, i) =>
			normalizeMessage(m, i, idMap, "parent"),
		);
		const childHistory = childMsgs.map((m, i) =>
			normalizeMessage(m, i, idMap, "child"),
		);

		// 6. Build snapshot
		const snapshot: SubagentSnapshot = {
			parentSession: {
				id: "ses_parent001",
				title: parentRaw.title ?? "Parent Session",
				updatedAt: BASE_TS,
				messageCount: parentMsgs.length,
			},
			childSession: {
				id: "ses_child001",
				title: childRaw.title ?? "Subagent Session",
				updatedAt: BASE_TS + 60_000,
				messageCount: childMsgs.length,
				parentID: "ses_parent001",
			},
			parentHistory: {
				messages: parentHistory,
				hasMore: false,
				total: parentMsgs.length,
			},
			childHistory: {
				messages: childHistory,
				hasMore: false,
				total: childMsgs.length,
			},
		};

		// 7. Write snapshot (Vitest file snapshot)
		await expect(JSON.stringify(snapshot, null, "\t")).toMatchFileSnapshot(
			SNAPSHOT_PATH,
		);
	});
});
