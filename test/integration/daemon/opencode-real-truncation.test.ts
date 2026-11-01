import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { Deferred, Effect } from "effect";
import { expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import type { TurnResult } from "../../../src/lib/provider/types.js";
import { resolveRealOpenCode } from "../../helpers/real-opencode.js";

// Failure cases: a rewind restores workspace bytes, truncates the wrong native
// tail or session, commits before deletion, or calls revert/fork. The adapter
// runs against the real HTTP API; only its final prompt uses noReply so this
// test neither loads credentials nor invokes a model.
it("truncates the real OpenCode transcript before prompting the same session without restoring files", async ({
	skip,
}) => {
	const root = mkdtempSync(join(tmpdir(), "conduit-real-truncation-"));
	const directory = join(root, "project");
	mkdirSync(directory);
	const environment = {
		PATH: process.env["PATH"] ?? "",
		HOME: root,
		TMPDIR: tmpdir(),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_CACHE_HOME: join(root, "cache"),
		OPENCODE_PURE: "true",
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ snapshot: false }),
	};
	const requests: Array<{
		method: string;
		url: string;
		body: unknown;
		responseCode?: number;
	}> = [];
	const events: ProviderRuntimeEvent[] = [];
	const evidence: Record<string, unknown> = {
		ticket: "conduit-test-82tn.55",
		at: new Date().toISOString(),
		promptMode: "adapter sendTurnEffect; SDK session.prompt with noReply:true",
		requests,
		events,
	};
	let server: ReturnType<typeof spawn> | undefined;
	let proxy: ReturnType<typeof createServer> | undefined;
	let output = "";
	try {
		let executable: string;
		try {
			executable = resolveRealOpenCode();
			const version = execFileSync(executable, ["--version"], {
				env: environment,
				encoding: "utf8",
				timeout: 15_000,
			}).trim();
			evidence["binary"] = { executable, version };
			const pinned = (
				JSON.parse(readFileSync("package.json", "utf8")) as {
					dependencies: Record<string, string>;
				}
			).dependencies["@opencode-ai/sdk"];
			if (version !== "1.19.1" || version !== pinned) {
				evidence["skip"] =
					`OpenCode ${version}, SDK pinned to ${pinned}; requires 1.19.1`;
				return skip(String(evidence["skip"]));
			}
		} catch (cause) {
			evidence["skip"] = `Pinned OpenCode unavailable: ${String(cause)}`;
			return skip(String(evidence["skip"]));
		}
		const probe = createServer();
		probe.listen(0, "127.0.0.1");
		await once(probe, "listening");
		const reserved = probe.address();
		if (!reserved || typeof reserved === "string")
			throw new TypeError("OpenCode port probe has no dynamic TCP address");
		await new Promise<void>((resolve) => probe.close(() => resolve()));
		expect([2633, 4096]).not.toContain(reserved.port);
		server = spawn(
			executable,
			["serve", "--hostname", "127.0.0.1", "--port", String(reserved.port)],
			{
				cwd: directory,
				env: environment,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const capture = (chunk: Buffer) => {
			output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
		};
		server.stdout?.on("data", capture);
		server.stderr?.on("data", capture);
		server.on("error", (cause) => {
			output = `${output}\n${String(cause)}`;
		});
		const child = server;
		const baseUrl = await new Promise<string>((resolve, reject) => {
			const cleanup = () => {
				child.stdout?.off("data", ready);
				child.off("error", failed);
				child.off("exit", exited);
			};
			const ready = () => {
				const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
				if (url) {
					cleanup();
					resolve(url);
				}
			};
			const failed = (cause: Error) => {
				cleanup();
				reject(cause);
			};
			const exited = () =>
				failed(
					new TypeError(`OpenCode exited before publishing its URL: ${output}`),
				);
			child.stdout?.on("data", ready);
			child.once("error", failed);
			child.once("exit", exited);
		});
		expect(new URL(baseUrl).port).toBe(String(reserved.port));
		evidence["nativeUrl"] = baseUrl;
		proxy = createServer(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const entry = {
				method: request.method ?? "GET",
				url: request.url ?? "/",
				body: body.length
					? (JSON.parse(body.toString("utf8")) as unknown)
					: null,
				responseCode: 0,
			};
			requests.push(entry);
			try {
				const headers = new Headers();
				for (const [name, value] of Object.entries(request.headers)) {
					if (value && name !== "host" && name !== "connection")
						headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				}
				const upstream = await fetch(`${baseUrl}${entry.url}`, {
					method: entry.method,
					headers,
					...(body.length ? { body } : {}),
					signal: AbortSignal.timeout(20_000),
				});
				entry.responseCode = upstream.status;
				response.statusCode = upstream.status;
				response.setHeader(
					"content-type",
					upstream.headers.get("content-type") ?? "application/json",
				);
				response.end(Buffer.from(await upstream.arrayBuffer()));
			} catch (cause) {
				entry.responseCode = 502;
				response.writeHead(502).end(String(cause));
			}
		});
		proxy.listen(0, "127.0.0.1");
		await once(proxy, "listening");
		const address = proxy.address();
		if (!address || typeof address === "string")
			throw new TypeError("Logging proxy has no dynamic TCP address");
		expect(address.port).not.toBe(2633);
		const proxyUrl = `http://127.0.0.1:${address.port}`;
		const sdk = createOpencodeClient({ baseUrl: proxyUrl, directory });
		const client = new OpenCodeAPI({ sdk, baseUrl: proxyUrl, authHeaders: {} });
		const session = await client.session.create({
			title: "Real rewind trace",
			directory,
		});
		evidence["sessionId"] = session.id;
		const model = { providerID: "anthropic", modelID: "claude-sonnet-4-5" };
		const seed = async (text: string, messageId?: string) => {
			const result = await sdk.session.prompt(
				{
					sessionID: session.id,
					directory,
					...(messageId ? { messageID: messageId } : {}),
					model,
					noReply: true,
					parts: [{ type: "text", text }],
				},
				{ throwOnError: true },
			);
			if (!result.data)
				throw new TypeError("Native noReply prompt returned no message");
			return result.data.info.id;
		};
		const workspaceFile = join(directory, "after-cut.txt");
		writeFileSync(workspaceFile, "original bytes before the cut\n");
		// This kept id sorts after every generated tail id. Native timestamps,
		// rather than lexical id ordering, must determine the cut.
		const kept = await seed("Keep this native message", "msg_conduit_zz_kept");
		const cut = await seed("Cut this native message");
		const tail: string[] = [];
		// Cross the common 100-message page size to prove the adapter reads the
		// complete native transcript before deciding which messages to delete.
		for (let index = 0; index < 101; index++)
			tail.push(await seed(`Remove native tail message ${index}`));
		const workspaceBytes = Buffer.from(
			"changed after the cut\n\0keep these bytes\n",
		);
		writeFileSync(workspaceFile, workspaceBytes);
		evidence["before"] = await client.session.messages(session.id);
		const intake = Deferred.makeUnsafe<TurnResult>();
		// Use the actual prompt endpoint with noReply instead of prompt_async.
		// This exercises adapter sequencing without requiring model credentials.
		client.session.prompt = async (sessionId, options) => {
			await sdk.session.prompt(
				{
					sessionID: sessionId,
					directory,
					...(options.messageId ? { messageID: options.messageId } : {}),
					model,
					noReply: true,
					parts: [{ type: "text", text: options.text }],
				},
				{ throwOnError: true },
			);
			Deferred.doneUnsafe(
				intake,
				Effect.succeed({
					status: "accepted",
					cost: 0,
					tokens: { input: 0, output: 0 },
					durationMs: 0,
					providerStateUpdates: [],
				}),
			);
		};
		const adapter = new OpenCodeProviderInstance({
			clientForSession: () => Effect.succeed(client),
		});
		const sendOffset = requests.length;
		const result = await Effect.runPromise(
			adapter.sendTurnEffect({
				sessionId: session.id,
				inputId: "real_rewind_trace",
				prompt: "Continue after the cut",
				history: [],
				providerState: {},
				workspaceRoot: directory,
				extraFolders: [],
				abortSignal: new AbortController().signal,
				awaitIntake: Deferred.await(intake),
				rewind: { resumeSessionAt: kept, targetMessageId: cut },
				eventSink: {
					push: (event) =>
						Effect.sync(() => {
							events.push(event);
						}),
					requestPermission: () => Effect.succeed({ decision: "once" }),
					requestQuestion: () => Effect.succeed({}),
					resolvePermission: () => Effect.void,
					resolveQuestion: () => Effect.void,
				},
			}),
		);
		const sendRequests = requests.slice(sendOffset);
		evidence["sendRequests"] = sendRequests;
		evidence["result"] = result;
		const after = await client.session.messages(session.id);
		evidence["after"] = after;
		evidence["workspaceByteIdentical"] =
			readFileSync(workspaceFile).equals(workspaceBytes);
		expect(result.status).toBe("accepted");
		expect(
			sendRequests
				.filter(({ method }) => method === "DELETE")
				.map(({ url }) => url.split("?")[0]),
		).toEqual([
			...[...tail]
				.reverse()
				.map((id) => `/session/${session.id}/message/${id}`),
			`/session/${session.id}/message/${cut}`,
		]);
		expect(
			sendRequests
				.filter(({ method }) => method === "POST")
				.map(({ url }) => url.split("?")[0]),
		).toEqual([`/session/${session.id}/message`]);
		const deletionEnd = sendRequests
			.map(({ method }) => method)
			.lastIndexOf("DELETE");
		expect(
			sendRequests.findIndex(({ method }) => method === "POST"),
		).toBeGreaterThan(deletionEnd);
		expect(
			requests.some(({ url }) =>
				/\/(?:revert|unrevert|fork)(?:[/?]|$)/.test(url),
			),
		).toBe(false);
		expect(after.map(({ id }) => id)).toEqual([
			kept,
			"msg_conduit_real_rewind_trace",
		]);
		expect(readFileSync(workspaceFile)).toEqual(workspaceBytes);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message.removed",
				sessionId: session.id,
				data: { messageId: cut },
			}),
		);
	} finally {
		if (proxy) {
			proxy.closeAllConnections();
			await new Promise<void>((resolve) => proxy?.close(() => resolve()));
		}
		if (server && server.exitCode === null && server.signalCode === null) {
			const exited = once(server, "exit");
			if (server.pid) process.kill(-server.pid, "SIGTERM");
			await exited;
		}
		evidence["serverOutput"] = output;
		mkdirSync("test-results/rewind", { recursive: true });
		writeFileSync(
			"test-results/rewind/opencode-real-truncation.json",
			JSON.stringify(evidence, null, 2),
		);
		rmSync(root, { recursive: true, force: true });
	}
});
