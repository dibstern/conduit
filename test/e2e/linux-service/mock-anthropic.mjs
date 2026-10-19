import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const artifacts = process.env.CONDUIT_E2E_ARTIFACTS ?? "/artifacts";
mkdirSync(artifacts, { recursive: true });
const logPath = join(artifacts, "mock-requests.jsonl");
const finalSentence = "Conduit runtime survival verified.";
const log = (event) => {
	const line = JSON.stringify({ at: new Date().toISOString(), ...event });
	appendFileSync(logPath, `${line}\n`);
	console.log(line);
};
const json = (response, status, body) => {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
};

const server = createServer(async (request, response) => {
	const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
	if (request.method !== "POST" || path !== "/v1/messages") {
		log({ event: "not-found", method: request.method, path });
		json(response, 404, {
			type: "error",
			error: {
				type: "not_found_error",
				message: "Mock supports POST /v1/messages only",
			},
		});
		return;
	}
	try {
		const chunks = [];
		let bytes = 0;
		for await (const chunk of request) {
			bytes += chunk.length;
			if (bytes > 10_000_000) throw new Error("Request exceeds 10 MB");
			chunks.push(chunk);
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const marker =
			JSON.stringify(body.messages ?? []).match(
				/CONDUIT_M37913_(?:A|B|C|CONTROL)\b/,
			)?.[0] ?? null;
		const id = `msg_${randomUUID().replaceAll("-", "")}`;
		const message = {
			id,
			type: "message",
			role: "assistant",
			model: body.model ?? "claude-sonnet-4-6",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: 10,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				output_tokens: 1,
			},
		};
		if (body.stream !== true) {
			log({ event: "non-streaming", id, marker });
			json(response, 200, {
				...message,
				content: [{ type: "text", text: "Mock response." }],
				stop_reason: "end_turn",
			});
			return;
		}
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
			"request-id": id,
		});
		response.flushHeaders();
		const sse = (type, data) =>
			response.write(
				`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
			);
		sse("message_start", { message });
		sse("content_block_start", {
			index: 0,
			content_block: { type: "text", text: "" },
		});
		log({ event: "started", id, marker });
		let index = 0;
		let completed = false;
		const timer = setInterval(() => {
			index++;
			const text =
				index === 40
					? `\n${finalSentence}`
					: `stream-${String(index).padStart(2, "0")} `;
			sse("content_block_delta", {
				index: 0,
				delta: { type: "text_delta", text },
			});
			log({ event: "delta", id, marker, index });
			if (index < 40) return;
			clearInterval(timer);
			sse("content_block_stop", { index: 0 });
			sse("message_delta", {
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 80 },
			});
			sse("message_stop", {});
			completed = true;
			response.end();
			log({ event: "finished", id, marker });
		}, 1000);
		response.once("close", () => {
			clearInterval(timer);
			if (!completed) log({ event: "disconnected", id, marker, index });
		});
	} catch (error) {
		log({ event: "error", message: String(error) });
		if (!response.headersSent)
			json(response, 400, {
				type: "error",
				error: { type: "invalid_request_error", message: String(error) },
			});
		else response.destroy();
	}
});
server.listen(18080, "127.0.0.1", () => {
	writeFileSync(
		join(artifacts, "mock-ready.json"),
		JSON.stringify({ pid: process.pid, port: 18080 }),
	);
	log({ event: "listening", pid: process.pid, port: 18080 });
});
