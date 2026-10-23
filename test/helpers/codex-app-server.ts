import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { ProviderInfo } from "../../src/lib/shared-types.js";
import type { ProcessBrowser, ProcessHarness } from "./process-harness.js";

export interface TraceRow {
	dir?: string;
	message?: {
		id?: string | number;
		method?: string;
		params?: Record<string, unknown>;
		result?: Record<string, unknown>;
		error?: { code: number; message: string };
	};
	[key: string]: unknown;
}

export interface StoredEvent {
	type: string;
	data: Record<string, unknown>;
	metadata: Record<string, unknown>;
}

export function rows<A>(path: string): A[] {
	return existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as A)
		: [];
}

export function fixtureRows(name: string): TraceRow[] {
	return rows(resolve(`test/fixtures/codex-app-server-traces/${name}.jsonl`));
}

export function signedInCodexDiscoveryTrace(): TraceRow[] {
	const trace = fixtureRows("model-list");
	const account = trace.find((row) => row.message?.result?.["account"] === null)
		?.message?.result;
	if (!account) throw new Error("Missing captured account/read");
	account["account"] = {
		type: "chatgpt",
		email: "codex-replay@example.test",
		planType: "plus",
	};
	account["requiresOpenaiAuth"] = true;
	return trace;
}

export async function codexModels(browser: ProcessBrowser, accountId: string) {
	const cursor = browser.frames.length;
	await browser.getModels(accountId);
	const catalog = await browser.waitFor(
		(message) =>
			message["type"] === "project_setting" &&
			message["_tag"] === "providerModels" &&
			message["accountId"] === accountId,
		cursor,
	);
	return (catalog["providers"] as ProviderInfo[])
		.filter(({ id }) => id === "codex")
		.flatMap(({ models }) => models);
}

export function snapshot(fixture: ProcessHarness, sessionId: string) {
	const db = new Database(fixture.daemonStorePath(), { readonly: true });
	try {
		return {
			events: db
				.prepare<[string], { type: string; data: string; metadata: string }>(
					"SELECT type, data, metadata FROM events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId)
				.map<StoredEvent>((event) => ({
					type: event.type,
					data: JSON.parse(event.data) as Record<string, unknown>,
					metadata: JSON.parse(event.metadata) as Record<string, unknown>,
				})),
			turns: db
				.prepare<[string], { state: string }>(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at, rowid",
				)
				.all(sessionId),
		};
	} finally {
		db.close();
	}
}
