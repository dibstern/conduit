import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	EnvelopeSchema,
	SessionInfoSchema,
} from "../../../src/lib/contracts/ws-rpc.js";
import * as mockupState from "../../e2e/fixtures/mockup-state.js";

// Historical relay fixtures are converted into RPC shell snapshots by the E2E
// mock. Validate their session rows against that surviving wire contract.

const fixturesDir = fileURLToPath(
	new URL("../../e2e/fixtures", import.meta.url),
);

const jsonFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return jsonFiles(path);
		return path.endsWith(".json") ? [path] : [];
	});

/** Every matching message anywhere in a fixture, however deeply nested. */
const messagesOfType = (
	value: unknown,
	type: string,
): Record<string, unknown>[] => {
	if (Array.isArray(value))
		return value.flatMap((item: unknown) => messagesOfType(item, type));
	if (value === null || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const nested = Object.values(record).flatMap((item) =>
		messagesOfType(item, type),
	);
	return record["type"] === type ? [record, ...nested] : nested;
};

const decodeShell = Schema.decodeUnknownEither(
	EnvelopeSchema(SessionInfoSchema),
);

const expectDecodable = (
	messages: readonly Record<string, unknown>[],
	source: string,
): void => {
	expect(
		messages.length,
		`${source} has no session_list message`,
	).toBeGreaterThan(0);
	for (const message of messages) {
		const result = decodeShell({
			_tag: "snapshot",
			sequence: 1,
			rows: message["sessions"],
		});
		if (Either.isLeft(result)) {
			throw new Error(`${source}: ${String(result.left)}`);
		}
	}
};

describe("e2e session fixtures decode at their wire boundaries", () => {
	for (const file of jsonFiles(fixturesDir)) {
		const contents: unknown = JSON.parse(readFileSync(file, "utf-8"));
		const messages = messagesOfType(contents, "session_list");
		if (messages.length === 0) continue;
		it(file.slice(fixturesDir.length + 1), () => {
			expectDecodable(messages, file);
		});
	}

	it("mockup-state.ts shell snapshots", () => {
		const snapshots = messagesOfType(mockupState, "shell_snapshot");
		expect(snapshots.length).toBeGreaterThan(0);
		for (const snapshot of snapshots) {
			const result = decodeShell({
				_tag: "snapshot",
				sequence: 1,
				rows: snapshot["sessions"],
			});
			if (Either.isLeft(result))
				throw new Error(`mockup-state.ts: ${String(result.left)}`);
		}
	});
});
