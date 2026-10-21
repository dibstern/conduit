/** Opt-in live contract capture for OpenCode text generation (ADR-0002). */
import { spawn } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { RecordingProxy } from "../../helpers/recording-proxy.js";
import type { OpenCodeRecording } from "../fixtures/recorded/types.js";

const enabled = process.env["RUN_EXPENSIVE_E2E"] === "1";
const fixtureDir = join(
	import.meta.dirname,
	"../../fixtures/opencode-wire-traces",
);
const object = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const redact = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(redact);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			typeof item === "string" &&
			/^(key|apiKey|api_key|access|refresh|access_token|refresh_token|authorization|token)$/i.test(
				key,
			)
				? "[REDACTED]"
				: redact(item),
		]),
	);
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server: Server) =>
	new Promise<string>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string")
				return reject(new Error("No loopback proxy address"));
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});

describe.skipIf(!enabled)("OpenCode title generation live capture", () => {
	it("captures one isolated synchronous text request and its deletion", async () => {
		const root = realpathSync(mkdtempSync("/tmp/conduit-title-wire-"));
		const project = join(root, "project");
		const scratch = join(
			root,
			"conduit-config",
			"text-generation",
			"run-capture",
		);
		for (const dir of ["home", "data/opencode", "config", "state", "cache"])
			mkdirSync(join(root, dir), { recursive: true });
		mkdirSync(project);
		mkdirSync(scratch, { recursive: true });
		const sentinel = "PROJECT_INSTRUCTIONS_MUST_NOT_REACH_TITLE_GENERATION";
		writeFileSync(join(project, "AGENTS.md"), sentinel);
		const authPath = join(
			process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
			"opencode",
			"auth.json",
		);
		if (existsSync(authPath))
			copyFileSync(authPath, join(root, "data", "opencode", "auth.json"));
		if (!existsSync(authPath) && !process.env["OPENROUTER_API_KEY"])
			throw new Error(
				"No usable OpenRouter auth is available for live capture",
			);

		const upstreamRequests: unknown[] = [];
		const providerProxy = createServer(async (req, res) => {
			try {
				const chunks: Buffer[] = [];
				for await (const chunk of req) chunks.push(Buffer.from(chunk));
				const body = Buffer.concat(chunks);
				if (body.length > 0) upstreamRequests.push(JSON.parse(body.toString()));
				const headers = new Headers();
				for (const [name, value] of Object.entries(req.headers))
					if (
						value !== undefined &&
						name !== "host" &&
						name !== "content-length"
					)
						headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				const response = await fetch(`https://openrouter.ai${req.url ?? "/"}`, {
					method: req.method ?? "GET",
					headers,
					...(body.length > 0 ? { body } : {}),
				});
				for (const [name, value] of response.headers)
					if (
						![
							"content-encoding",
							"content-length",
							"transfer-encoding",
						].includes(name)
					)
						res.setHeader(name, value);
				res.writeHead(response.status);
				if (response.body)
					for await (const chunk of response.body)
						res.write(Buffer.from(chunk));
				res.end();
			} catch (error) {
				res.writeHead(502);
				res.end(String(error));
			}
		});
		const providerUrl = await listen(providerProxy);
		const env = {
			...process.env,
			HOME: join(root, "home"),
			XDG_DATA_HOME: join(root, "data"),
			XDG_CONFIG_HOME: join(root, "config"),
			XDG_STATE_HOME: join(root, "state"),
			XDG_CACHE_HOME: join(root, "cache"),
			OPENCODE_SERVER_PASSWORD: "",
			OPENCODE_CONFIG: "",
			OPENCODE_CONFIG_DIR: "",
			OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
			OPENCODE_DISABLE_CLAUDE_CODE: "true",
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				plugin: [],
				mcp: {},
				instructions: [],
				share: "disabled",
				autoupdate: false,
				provider: {
					openrouter: { options: { baseURL: `${providerUrl}/api/v1` } },
				},
			}),
		};
		const child = spawn(
			"opencode",
			["serve", "--hostname", "127.0.0.1", "--port", "0"],
			{
				cwd: scratch,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16_000);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-16_000);
		});
		const streams: { controller: AbortController; pump: Promise<void> }[] = [];
		const envelopes: { stream: string; data: unknown }[] = [];
		let proxy: RecordingProxy | undefined;
		let sessionId: string | undefined;
		let request:
			| ((
					method: string,
					path: string,
					body?: unknown,
					directory?: string,
			  ) => Promise<{ status: number; body: unknown }>)
			| undefined;
		try {
			const deadline = Date.now() + 30_000;
			let url: string | undefined;
			while (Date.now() < deadline) {
				url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
				if (
					url &&
					(await fetch(`${url}/global/health`).catch(() => undefined))?.ok
				)
					break;
				if (child.exitCode !== null || child.signalCode !== null)
					throw new Error(`OpenCode exited: ${output}`);
				await pause(100);
			}
			if (!url) throw new Error(`OpenCode did not start: ${output}`);
			proxy = new RecordingProxy(url);
			await proxy.start();
			const proxyUrl = proxy.url;
			request = async (method, path, body, directory = scratch) => {
				const response = await fetch(
					`${proxyUrl}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}`,
					{
						method,
						headers: {
							"content-type": "application/json",
							"accept-encoding": "identity",
						},
						...(body !== undefined ? { body: JSON.stringify(body) } : {}),
						signal: AbortSignal.timeout(120_000),
					},
				);
				const text = await response.text();
				return {
					status: response.status,
					body: text ? (JSON.parse(text) as unknown) : null,
				};
			};
			for (const [stream, path] of [
				["global", "/global/event"],
				["project", `/event?directory=${encodeURIComponent(project)}`],
			] as const) {
				const controller = new AbortController();
				const response = await fetch(`${proxyUrl}${path}`, {
					signal: controller.signal,
				});
				const reader = response.body?.getReader();
				if (!reader) throw new Error(`No ${stream} SSE reader`);
				const pump = (async () => {
					const decoder = new TextDecoder();
					let buffer = "";
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							buffer += decoder.decode(value, { stream: true });
							const blocks = buffer.split("\n\n");
							buffer = blocks.pop() ?? "";
							for (const line of blocks.flatMap((block) => block.split("\n")))
								if (line.startsWith("data: "))
									envelopes.push({
										stream,
										data: JSON.parse(line.slice(6)) as unknown,
									});
						}
					} catch {
						// The capture owns and aborts these streams during cleanup.
					}
				})();
				streams.push({ controller, pump });
			}
			await request("GET", "/config");
			await request("GET", "/path");
			const agents = await request("GET", "/agent");
			const hasTitleAgent =
				Array.isArray(agents.body) &&
				agents.body.some((value: unknown) => object(value)["name"] === "title");
			const catalogResponse = await fetch(
				`${url}/config/providers?directory=${encodeURIComponent(scratch)}`,
			);
			const catalog = object(await catalogResponse.json());
			const providers = Array.isArray(catalog["providers"])
				? catalog["providers"]
				: [];
			const provider = providers
				.map(object)
				.find((value) => value["id"] === "openrouter");
			if (!provider)
				throw new Error("No usable OpenRouter provider exists on this machine");
			const models = Object.values(object(provider["models"]))
				.map(object)
				.filter((model) => {
					const modalities = object(model["modalities"]);
					return (
						typeof model["id"] === "string" &&
						(!Array.isArray(modalities["input"]) ||
							modalities["input"].includes("text")) &&
						(!Array.isArray(modalities["output"]) ||
							modalities["output"].includes("text"))
					);
				});
			const free = models.filter(
				(model) =>
					model["id"]?.toString().endsWith(":free") ||
					(object(model["cost"])["input"] === 0 &&
						object(model["cost"])["output"] === 0),
			);
			const model =
				free.find((value) => value["id"] === "liquid/lfm-2.5-2.6b:free") ??
				[...(free.length > 0 ? free : models)].sort(
					(a, b) =>
						Number(object(a["cost"])["input"] ?? Infinity) +
						Number(object(a["cost"])["output"] ?? Infinity) -
						Number(object(b["cost"])["input"] ?? Infinity) -
						Number(object(b["cost"])["output"] ?? Infinity),
				)[0];
			if (!model)
				throw new Error("OpenRouter has no discovered text-chat model");
			await request("GET", "/provider");
			const created = await request("POST", "/session", {
				title: "Conduit temporary text generation",
				permission: [{ permission: "*", pattern: "*", action: "deny" }],
			});
			expect(created.status).toBe(200);
			sessionId = String(object(created.body)["id"]);
			const reply = await request("POST", `/session/${sessionId}/message`, {
				model: { providerID: "openrouter", modelID: model["id"] },
				variant: "",
				...(hasTitleAgent ? { agent: "title" } : {}),
				system: "Return a short title only, without quotes or explanation.",
				parts: [{ type: "text", text: "Fix login redirect loop" }],
				tools: { "*": false },
			});
			const parts = object(reply.body)["parts"];
			const text = Array.isArray(parts)
				? parts
						.map(object)
						.filter((part) => part["type"] === "text")
						.map((part) => part["text"])
						.join("")
				: "";
			await request("POST", `/session/${sessionId}/abort`);
			const deleted = await request("DELETE", `/session/${sessionId}`);
			const afterDelete = await request("GET", `/session/${sessionId}`);
			const projectSessions = await request(
				"GET",
				"/session",
				undefined,
				project,
			);
			await pause(100);
			const health = object(await (await fetch(`${url}/global/health`)).json());
			const recording: OpenCodeRecording = {
				name: "title-generation",
				recordedAt: new Date().toISOString(),
				opencodeVersion: String(health["version"]),
				interactions: proxy.getRecording(),
			};
			mkdirSync(fixtureDir, { recursive: true });
			writeFileSync(
				join(fixtureDir, "title-generation.json.gz"),
				gzipSync(`${JSON.stringify(redact(recording))}\n`),
			);
			writeFileSync(
				join(fixtureDir, "title-generation.envelopes.jsonl"),
				`${envelopes.map((event) => JSON.stringify(event)).join("\n")}\n`,
			);
			writeFileSync(
				join(fixtureDir, "title-generation.provider-requests.json"),
				`${JSON.stringify(upstreamRequests, null, "\t")}\n`,
			);
			const evidence = {
				modelId: model["id"],
				cost: model["cost"],
				hasTitleAgent,
				text,
				status: reply.status,
				error: object(reply.body)["info"],
				deleted,
				afterDelete,
				projectSessions,
				root,
				scratch,
				project,
				providerRequests: upstreamRequests.length,
				projectReceivedScratch: envelopes.some(
					(event) =>
						event.stream === "project" &&
						JSON.stringify(event.data).includes(sessionId ?? "missing"),
				),
				sentinelInProviderRequest:
					JSON.stringify(upstreamRequests).includes(sentinel),
			};
			writeFileSync(
				join(fixtureDir, "title-generation.evidence.json"),
				`${JSON.stringify(evidence, null, "\t")}\n`,
			);
			expect(reply.status).toBe(200);
			expect(text.length).toBeGreaterThan(0);
			expect(deleted.status).toBe(200);
			expect(afterDelete.status).toBe(404);
			expect(evidence.projectReceivedScratch).toBe(false);
			expect(evidence.sentinelInProviderRequest).toBe(false);
			expect(upstreamRequests).toHaveLength(1);
			console.log(
				JSON.stringify({
					modelId: model["id"],
					text,
					providerRequests: upstreamRequests.length,
					scratch,
					sessionId,
				}),
			);
		} finally {
			if (sessionId && request)
				await request("DELETE", `/session/${sessionId}`).catch(() => undefined);
			for (const stream of streams) stream.controller.abort();
			await Promise.all(streams.map((stream) => stream.pump));
			proxy?.reset();
			await proxy?.stop();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await Promise.race([
					new Promise<void>((resolve) => child.once("exit", () => resolve())),
					pause(3_000),
				]);
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await new Promise<void>((resolve) =>
						child.once("exit", () => resolve()),
					);
				}
			}
			providerProxy.closeAllConnections();
			await new Promise<void>((resolve) =>
				providerProxy.close(() => resolve()),
			);
			rmSync(root, { recursive: true, force: true });
		}
	}, 180_000);

	it("captures a reserved session lifecycle without prompting", async () => {
		const root = realpathSync(mkdtempSync("/tmp/conduit-title-lifecycle-"));
		const scratch = join(
			root,
			"conduit-config",
			"text-generation",
			"run-capture",
		);
		for (const directory of [
			"home",
			"data",
			"config",
			"state",
			"cache",
			"conduit-config/text-generation/run-capture",
		])
			mkdirSync(join(root, directory), { recursive: true });
		const child = spawn(
			"opencode",
			["serve", "--hostname", "127.0.0.1", "--port", "0"],
			{
				cwd: scratch,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					HOME: join(root, "home"),
					XDG_DATA_HOME: join(root, "data"),
					XDG_CONFIG_HOME: join(root, "config"),
					XDG_STATE_HOME: join(root, "state"),
					XDG_CACHE_HOME: join(root, "cache"),
					OPENCODE_SERVER_PASSWORD: "",
					OPENCODE_CONFIG: "",
					OPENCODE_CONFIG_DIR: "",
					OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
					OPENCODE_DISABLE_CLAUDE_CODE: "true",
					OPENCODE_CONFIG_CONTENT: JSON.stringify({
						plugin: [],
						mcp: {},
						instructions: [],
						share: "disabled",
						autoupdate: false,
					}),
				},
			},
		);
		let output = "";
		for (const stream of [child.stdout, child.stderr])
			stream.on("data", (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-16_000);
			});
		let proxy: RecordingProxy | undefined;
		const sessionId = `ses_title_${Date.now().toString(16)}`;
		let request:
			| ((
					method: string,
					path: string,
					body?: unknown,
			  ) => Promise<{ status: number; body: unknown }>)
			| undefined;
		try {
			let url: string | undefined;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
				if (
					url &&
					(await fetch(`${url}/global/health`).catch(() => undefined))?.ok
				)
					break;
				if (child.exitCode !== null || child.signalCode !== null)
					throw new Error(`OpenCode exited: ${output}`);
				await pause(100);
			}
			if (!url) throw new Error(`OpenCode did not start: ${output}`);
			const doc = object(await (await fetch(`${url}/doc`)).json());
			const paths = object(doc["paths"]);
			const create = object(
				object(
					object(object(object(paths["/api/session"])["post"])["requestBody"])[
						"content"
					],
				)["application/json"],
			);
			expect(object(object(create["schema"])["properties"])).toHaveProperty(
				"id",
			);
			expect(object(paths["/session/{sessionID}"])).toHaveProperty("patch");
			proxy = new RecordingProxy(url);
			await proxy.start();
			const proxyUrl = proxy.url;
			request = async (method, path, body) => {
				const response = await fetch(
					`${proxyUrl}${path}?directory=${encodeURIComponent(scratch)}`,
					{
						method,
						headers: {
							"content-type": "application/json",
							"accept-encoding": "identity",
						},
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
						signal: AbortSignal.timeout(15_000),
					},
				);
				const text = await response.text();
				return {
					status: response.status,
					body: text ? (JSON.parse(text) as unknown) : null,
				};
			};
			expect(
				(
					await request("POST", "/api/session", {
						id: sessionId,
						location: { directory: scratch },
					})
				).status,
			).toBe(200);
			expect(
				(
					await request("PATCH", `/session/${sessionId}`, {
						title: "Conduit ephemeral text generation",
						permission: [{ permission: "*", pattern: "*", action: "deny" }],
					})
				).status,
			).toBe(200);
			const session = await request("GET", `/session/${sessionId}`);
			expect(session.status).toBe(200);
			expect(object(session.body)).toMatchObject({
				id: sessionId,
				title: "Conduit ephemeral text generation",
				permission: [{ permission: "*", pattern: "*", action: "deny" }],
			});
			expect(
				(await request("POST", `/session/${sessionId}/abort`)).status,
			).toBe(200);
			expect((await request("DELETE", `/session/${sessionId}`)).status).toBe(
				200,
			);
			expect((await request("GET", `/session/${sessionId}`)).status).toBe(404);
			const health = object(await (await fetch(`${url}/global/health`)).json());
			const recording: OpenCodeRecording = {
				name: "title-session-lifecycle",
				recordedAt: new Date().toISOString(),
				opencodeVersion: String(health["version"]),
				interactions: proxy.getRecording(),
			};
			mkdirSync(fixtureDir, { recursive: true });
			writeFileSync(
				join(fixtureDir, "title-session-lifecycle.json"),
				`${JSON.stringify(recording, null, "\t")}\n`,
			);
			expect(recording.interactions).toHaveLength(6);
		} finally {
			if (request)
				await request("DELETE", `/session/${sessionId}`).catch(() => undefined);
			await proxy?.stop();
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await Promise.race([
					new Promise<void>((resolve) => child.once("exit", () => resolve())),
					pause(3_000),
				]);
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await new Promise<void>((resolve) =>
						child.once("exit", () => resolve()),
					);
				}
			}
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
