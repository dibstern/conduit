import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { OpenCodeAPI } from "../../src/lib/instance/opencode-api.js";
import { createSdkClient } from "../../src/lib/instance/sdk-factory.js";
import type { OpenCodeRecording } from "../e2e/fixtures/recorded/types.js";

/** Replay only captured responses; unexpected calls fail instead of inventing data. */
export function replayOpenCodeText() {
	const trace = JSON.parse(
		gunzipSync(
			readFileSync(
				new URL(
					"../fixtures/opencode-wire-traces/title-generation.json.gz",
					import.meta.url,
				),
			),
		).toString("utf8"),
	) as OpenCodeRecording;
	const lifecycle = JSON.parse(
		readFileSync(
			new URL(
				"../fixtures/opencode-wire-traces/title-session-lifecycle.json",
				import.meta.url,
			),
			"utf8",
		),
	) as OpenCodeRecording;
	let sessionId: string | undefined;
	const requests: Request[] = [];
	const route = (path: string) =>
		path.replace(/\/session\/[^/]+/, "/session/:id");
	const fetchReplay: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push(request.clone());
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/api/session")
			sessionId = ((await request.clone().json()) as { id: string }).id;
		const captured = [...lifecycle.interactions, ...trace.interactions].find(
			(entry) =>
				entry.kind === "rest" &&
				entry.method === request.method &&
				route(new URL(entry.path, "http://capture").pathname) === route(path),
		);
		if (!captured || captured.kind !== "rest")
			throw new Error(`No captured response for ${request.method} ${path}`);
		// Reserved session ids vary per run; normalize only their identities.
		let body = JSON.stringify(captured.responseBody);
		if (sessionId) body = body.replace(/ses_[A-Za-z0-9_]+/g, sessionId);
		return new Response(body, {
			status: captured.status,
			headers: { "content-type": "application/json" },
		});
	};
	const transport = { fetch: fetchReplay };
	const client = (directory: string) => {
		const sdk = createSdkClient({
			baseUrl: "http://127.0.0.1:1",
			directory,
			retry: {
				retries: 0,
				baseFetch: (input, init) => transport.fetch(input, init),
			},
		});
		return new OpenCodeAPI({
			sdk: sdk.client,
			baseUrl: "http://127.0.0.1:1",
			authHeaders: {},
		});
	};
	const prompt = trace.interactions.find(
		(entry) =>
			entry.kind === "rest" &&
			entry.method === "POST" &&
			/\/message(?:\?|$)/.test(entry.path),
	);
	if (!prompt || prompt.kind !== "rest")
		throw new Error("Capture has no prompt");
	const body = prompt.requestBody as {
		model: { providerID: string; modelID: string };
		system: string;
		parts: { type: string; text: string }[];
	};
	const response = prompt.responseBody as {
		info: { sessionID: string };
		parts: { type: string; text?: string }[];
	};
	return {
		trace,
		requests,
		transport,
		client,
		model: { providerId: body.model.providerID, modelId: body.model.modelID },
		instructions: body.system,
		prompt: body.parts.map((part) => part.text).join(""),
		sessionId: response.info.sessionID,
		reply: response.parts
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join(""),
	};
}
