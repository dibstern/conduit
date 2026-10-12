// Failure modes: a missing or blank account folder inherits the daemon login;
// transcript reads and forks use different accounts; a worker mutates daemon env;
// an SDK-default folder is accidentally treated as explicitly configured.
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	configuredClaudeConfigDir,
	sdkDefaultClaudeConfigDir,
} from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	defaultClaudeSessionForkSdk,
	forkClaudeTranscript,
	resolveForkUpToUuid,
} from "../../../../src/lib/provider/claude/claude-session-fork.js";

afterEach(() => vi.unstubAllEnvs());

const entry = (
	uuid: string,
	type: SessionMessage["type"],
	message: unknown,
): SessionMessage => ({
	uuid,
	type,
	message,
	session_id: "sdk-parent",
	parent_tool_use_id: null,
	parent_agent_id: null,
});

describe("resolveForkUpToUuid", () => {
	it("includes assistant work and tool results through the end of the turn", () => {
		const messages = [
			entry("prompt-1", "user", { content: "Question" }),
			entry("thinking", "assistant", {
				id: "msg-first",
				content: [{ type: "thinking" }],
			}),
			entry("tool", "assistant", {
				id: "msg-first",
				content: [{ type: "tool_use" }],
			}),
			entry("result", "user", { content: [{ type: "tool_result" }] }),
			entry("answer", "assistant", {
				id: "msg-second",
				content: [{ type: "text" }],
			}),
			entry("prompt-2", "user", { content: [{ type: "text", text: "Next" }] }),
			entry("next-answer", "assistant", {
				id: "msg-third",
				content: "Next answer",
			}),
		];
		expect(resolveForkUpToUuid(messages, "msg-first")).toBe("answer");
		expect(resolveForkUpToUuid(messages, "msg-third")).toBe("next-answer");
		expect(resolveForkUpToUuid(messages, "missing")).toBeUndefined();
	});
});

describe("forkClaudeTranscript", () => {
	it.each([
		"",
		"  ",
	])("rejects a blank account folder before any SDK call: %j", async (configDir) => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/daemon/claude");
		const readTranscript = vi.fn(async () => []);
		const forkSession = vi.fn(async () => ({ sessionId: "sdk-fork" }));
		await expect(
			forkClaudeTranscript(
				{
					parentSdkId: "sdk-parent",
					projectDir: "/project",
					configDir: {
						...configuredClaudeConfigDir("/instance-config"),
						path: configDir,
					},
					title: "Fork",
					messageId: "msg_1",
				},
				{ readTranscript, forkSession },
			),
		).rejects.toThrow("Claude config directory must be non-empty");
		expect(readTranscript).not.toHaveBeenCalled();
		expect(forkSession).not.toHaveBeenCalled();
	});

	it("passes the instance config dir to every SDK call", async () => {
		const readTranscript = vi.fn(async () => [
			entry("u1", "user", { role: "user", content: "Question" }),
			entry("a1", "assistant", { id: "msg_1", content: [] }),
		]);
		const forkSession = vi.fn(async () => ({ sessionId: "sdk-fork" }));
		const result = await forkClaudeTranscript(
			{
				parentSdkId: "sdk-parent",
				projectDir: "/project",
				configDir: configuredClaudeConfigDir("/instance-config"),
				title: "Fork",
				messageId: "msg_1",
			},
			{ readTranscript, forkSession },
		);
		expect(result).toEqual({ sdkSessionId: "sdk-fork" });
		expect(readTranscript).toHaveBeenCalledWith("sdk-parent", {
			dir: "/project",
			configDir: configuredClaudeConfigDir("/instance-config"),
		});
		expect(forkSession).toHaveBeenCalledWith("sdk-parent", {
			dir: "/project",
			configDir: configuredClaudeConfigDir("/instance-config"),
			title: "Fork",
			upToMessageId: "a1",
		});
	});

	it("rejects an unknown fork point without forking", async () => {
		const forkSession = vi.fn(async () => ({ sessionId: "sdk-fork" }));
		await expect(
			forkClaudeTranscript(
				{
					parentSdkId: "sdk-parent",
					projectDir: "/project",
					configDir: configuredClaudeConfigDir("/instance-config"),
					title: "Fork",
					messageId: "missing",
				},
				{ readTranscript: async () => [], forkSession },
			),
		).rejects.toThrow("was not found in the Claude transcript");
		expect(forkSession).not.toHaveBeenCalled();
	});

	it("uses the newest earlier assistant found in the transcript", async () => {
		const forkSession = vi.fn(async () => ({ sessionId: "sdk-fork" }));
		const readTranscript = vi.fn(async () => [
			entry("prompt-1", "user", { content: "Question" }),
			entry("thinking-1", "assistant", { id: "known", content: "Thinking" }),
			entry("answer-1", "assistant", { id: "answer", content: "Answer" }),
			entry("prompt-2", "user", { content: "Next" }),
			entry("answer-2", "assistant", { id: "later", content: "Later" }),
		]);
		await forkClaudeTranscript(
			{
				parentSdkId: "sdk-parent",
				projectDir: "/project",
				configDir: configuredClaudeConfigDir("/instance-config"),
				title: "Fork",
				messageId: "result-only",
				fallbackMessageIds: ["missing", "known"],
			},
			{ readTranscript, forkSession },
		);
		expect(forkSession).toHaveBeenCalledWith("sdk-parent", {
			dir: "/project",
			configDir: configuredClaudeConfigDir("/instance-config"),
			title: "Fork",
			upToMessageId: "answer-1",
		});
	});

	it("rejects when the target and every fallback are absent", async () => {
		const forkSession = vi.fn(async () => ({ sessionId: "sdk-fork" }));
		await expect(
			forkClaudeTranscript(
				{
					parentSdkId: "sdk-parent",
					projectDir: "/project",
					configDir: configuredClaudeConfigDir("/instance-config"),
					title: "Fork",
					messageId: "result-only",
					fallbackMessageIds: ["also-missing"],
				},
				{ readTranscript: async () => [], forkSession },
			),
		).rejects.toThrow("was not found in the Claude transcript");
		expect(forkSession).not.toHaveBeenCalled();
	});
});

describe("defaultClaudeSessionForkSdk", () => {
	it.each([
		"",
		"  ",
	])("rejects a blank folder before starting a transcript worker: %j", async (configDir) => {
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/daemon/claude");
		await expect(
			defaultClaudeSessionForkSdk.readTranscript("sdk-parent", {
				dir: "/project",
				configDir: {
					...configuredClaudeConfigDir("/instance-config"),
					path: configDir,
				},
			}),
		).rejects.toThrow("Claude config directory must be non-empty");
		await expect(
			defaultClaudeSessionForkSdk.forkSession("sdk-parent", {
				dir: "/project",
				configDir: {
					...configuredClaudeConfigDir("/instance-config"),
					path: configDir,
				},
				title: "Fork",
			}),
		).rejects.toThrow("Claude config directory must be non-empty");
	});

	it.each([
		"configured",
		"sdk-default",
	])("works under a %s config dir without touching the daemon env", async (source) => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-fork-")));
		const configDir = join(home, ".claude");
		const accountFolder =
			source === "sdk-default"
				? sdkDefaultClaudeConfigDir(configDir)
				: configuredClaudeConfigDir(configDir);
		const projectDir = join(home, "workspace");
		const transcriptDir = join(
			configDir,
			"projects",
			projectDir.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		mkdirSync(projectDir);
		mkdirSync(transcriptDir, { recursive: true });
		const sessionId = randomUUID();
		const line = (uuid: string, parentUuid: string | null, message: unknown) =>
			JSON.stringify({
				type: (message as { role: string }).role,
				uuid,
				parentUuid,
				sessionId,
				isSidechain: false,
				cwd: projectDir,
				timestamp: new Date().toISOString(),
				message,
			});
		writeFileSync(
			join(transcriptDir, `${sessionId}.jsonl`),
			`${[line(randomUUID(), null, { role: "user", content: "Question" })].join(
				"\n",
			)}\n`,
		);
		vi.stubEnv("CLAUDE_CONFIG_DIR", join(configDir, "conflicting-account"));
		const daemonEnv = process.env["CLAUDE_CONFIG_DIR"];
		try {
			const messages = await defaultClaudeSessionForkSdk.readTranscript(
				sessionId,
				{ dir: projectDir, configDir: accountFolder },
			);
			expect(messages).toHaveLength(1);
			const fork = await defaultClaudeSessionForkSdk.forkSession(sessionId, {
				dir: projectDir,
				configDir: accountFolder,
				title: "Fork",
			});
			expect(existsSync(join(transcriptDir, `${fork.sessionId}.jsonl`))).toBe(
				true,
			);
			expect(process.env["CLAUDE_CONFIG_DIR"]).toBe(daemonEnv);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
