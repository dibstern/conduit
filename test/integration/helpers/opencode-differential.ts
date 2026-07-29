// ─── OpenCode Differential Helpers ───────────────────────────────────────────
// Helpers for tests that compare provider REST history against the durable
// projection ("differentials").
//
// The pitfall these exist for: a session created without deliberately routing it
// to OpenCode is a *local* session (provider "claude") and never touches the
// OpenCode mock. A differential run against such a session compares the
// projection with itself and passes trivially. Two tests (REPRO-E/F) did exactly
// that until they were rebound.
//
// Rule: a differential asserts ONLY on the session id returned by
// materializeOpenCodeTurn, which hard-fails unless that session's durable row is
// provider="opencode".

import type { OpenCodeMessage } from "../../../src/lib/contracts/providers/opencode-sdk.js";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import type { TestWsClient } from "./test-ws-client.js";

// Schema-complete message infos: loadPreRenderedHistory decodes REST bodies
// against OpenCodeMessageSchema, which requires agent/model on user messages
// and parentID/modelID/providerID/mode/path/cost/tokens on assistant
// messages. Minimal infos fail decode and silently downgrade the "REST" side
// of the differential to the projection fallback — trivial parity. The
// OpenCodeMessage return types make the compiler enforce that completeness, so
// schema drift breaks the build instead of silently reopening the hole.
export function userInfo(
	sessionId: string,
	id: string,
	created: number,
): Extract<OpenCodeMessage, { role: "user" }> {
	return {
		id,
		sessionID: sessionId,
		role: "user",
		time: { created },
		agent: "build",
		model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
	};
}

export function assistantInfo(
	sessionId: string,
	id: string,
	created: number,
	completed?: number,
): Extract<OpenCodeMessage, { role: "assistant" }> {
	return {
		id,
		sessionID: sessionId,
		role: "assistant",
		time: { created, ...(completed != null ? { completed } : {}) },
		parentID: "",
		modelID: "claude-sonnet-4-5",
		providerID: "anthropic",
		mode: "build",
		path: { cwd: "/", root: "/" },
		cost: 0,
		tokens: {
			input: 10,
			output: 5,
			reasoning: 0,
			cache: { read: 0, write: 0 },
		},
	};
}

function sessionProvider(
	dbPath: string,
	sessionId: string,
): string | undefined {
	const db = SqliteClient.open(dbPath);
	try {
		return db.queryOne<{ provider: string }>(
			"SELECT provider FROM sessions WHERE id = ?",
			[sessionId],
		)?.provider;
	} finally {
		db.close();
	}
}

/**
 * Bind a fresh session to the OpenCode engine (REPRO-C's materialization
 * pattern). Without this the default session runs on the Claude provider and
 * never touches the mock — the "differential" would silently compare the
 * projection with itself. Returns the local session id; the first sendMessage
 * to it materializes an OpenCode session (session_switched with a new id).
 */
export async function bindOpenCodeSession(
	client: TestWsClient,
	dbPath: string,
	title: string,
): Promise<string> {
	const modelList = await client.waitFor("model_list");
	const providers = modelList["providers"] as Array<{
		id: string;
		models: Array<{ id: string }>;
	}>;
	const provider = providers?.find(
		(candidate) => candidate.id !== "claude" && candidate.models.length > 0,
	);
	if (!provider) throw new Error("model_list has no OpenCode provider");
	const model = provider.models[0];
	if (!model) throw new Error("OpenCode provider has no models");

	const created = await client.createSession(title, { providerId: "claude" });
	const localId = created["id"] as string;
	if (!localId) throw new Error("createSession returned no id");
	await client.switchModel(model.id, provider.id, localId);
	await new Promise((resolve) => setTimeout(resolve, 250));

	const boundProvider = sessionProvider(dbPath, localId);
	if (boundProvider === undefined || boundProvider === "opencode") {
		throw new Error(
			`bindOpenCodeSession: session ${localId} has provider="${boundProvider ?? "<no row>"}"; ` +
				"the differential pattern needs a local session that materializes onto OpenCode on first send. " +
				"Nothing will materialize and materializeOpenCodeTurn will time out; bypassing materialization " +
				"would let a REST-vs-projection differential compare the projection with itself and pass trivially.",
		);
	}
	client.clearReceived();
	return localId;
}

/** Send the first message to a bound session and wait for materialization. */
export async function materializeOpenCodeTurn(
	client: TestWsClient,
	dbPath: string,
	localId: string,
	prompt: string,
): Promise<string> {
	await client.sendMessage(prompt, {
		sessionId: localId,
		originId: client.getClientId(),
	});
	const switched = await client.waitFor("session_switched", {
		timeout: 15_000,
		predicate: (message) => message["id"] !== localId,
	});
	const sessionId = switched["id"] as string;

	const provider = sessionProvider(dbPath, sessionId);
	if (provider !== "opencode") {
		throw new Error(
			`materializeOpenCodeTurn: session ${sessionId} has provider="${provider ?? "<no row>"}", expected "opencode". ` +
				"The turn never ran on the OpenCode mock, so a REST-vs-projection differential on this session " +
				"would compare the projection with itself and pass trivially.",
		);
	}
	return sessionId;
}
