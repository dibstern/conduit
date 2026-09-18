import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { RelayMessageSchema } from "../../../src/lib/shared-types.js";
import * as mockupState from "../../e2e/fixtures/mockup-state.js";

// The e2e and acceptance runs replay canned relay traffic into the real
// frontend, which decodes every message through RelayMessageSchema. A fixture
// that predates the single session wire type (ni8.5 T-1) therefore fails at the
// boundary rather than in a test, and the run reports a missing session instead
// of a stale fixture. Decode them here, where the failure names the file.

const fixturesDir = fileURLToPath(
	new URL("../../e2e/fixtures", import.meta.url),
);

const jsonFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return jsonFiles(path);
		return path.endsWith(".json") ? [path] : [];
	});

/** Every `session_list` message anywhere in a fixture, however deeply nested. */
const sessionLists = (value: unknown): unknown[] => {
	if (Array.isArray(value)) return value.flatMap(sessionLists);
	if (value === null || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const nested = Object.values(record).flatMap(sessionLists);
	return record["type"] === "session_list" ? [record, ...nested] : nested;
};

const decode = Schema.decodeUnknownEither(RelayMessageSchema);

const expectDecodable = (
	messages: readonly unknown[],
	source: string,
): void => {
	expect(
		messages.length,
		`${source} has no session_list message`,
	).toBeGreaterThan(0);
	for (const message of messages) {
		const result = decode(message);
		if (Either.isLeft(result)) {
			throw new Error(`${source}: ${String(result.left)}`);
		}
	}
};

describe("e2e session_list fixtures decode as relay messages", () => {
	for (const file of jsonFiles(fixturesDir)) {
		const messages = sessionLists(
			JSON.parse(readFileSync(file, "utf-8")) as unknown,
		);
		if (messages.length === 0) continue;
		it(file.slice(fixturesDir.length + 1), () => {
			expectDecodable(messages, file);
		});
	}

	it("mockup-state.ts", () => {
		expectDecodable(sessionLists(mockupState), "mockup-state.ts");
	});
});
