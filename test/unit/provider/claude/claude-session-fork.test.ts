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
import { describe, expect, it, vi } from "vitest";
import {
	defaultClaudeSessionForkSdk,
	forkClaudeTranscript,
	resolveForkUpToUuid,
} from "../../../../src/lib/provider/claude/claude-session-fork.js";

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
				configDir: "/instance-config",
				title: "Fork",
				messageId: "msg_1",
			},
			{ readTranscript, forkSession },
		);
		expect(result).toEqual({ sdkSessionId: "sdk-fork" });
		expect(readTranscript).toHaveBeenCalledWith("sdk-parent", {
			dir: "/project",
			configDir: "/instance-config",
		});
		expect(forkSession).toHaveBeenCalledWith("sdk-parent", {
			dir: "/project",
			configDir: "/instance-config",
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
					title: "Fork",
					messageId: "missing",
				},
				{ readTranscript: async () => [], forkSession },
			),
		).rejects.toThrow("was not found in the Claude transcript");
		expect(forkSession).not.toHaveBeenCalled();
	});
});

describe("defaultClaudeSessionForkSdk", () => {
	it("works under the instance config dir without touching the daemon env", async () => {
		const configDir = realpathSync(mkdtempSync(join(tmpdir(), "claude-fork-")));
		const projectDir = join(configDir, "workspace");
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
		const daemonEnv = process.env["CLAUDE_CONFIG_DIR"];
		try {
			const messages = await defaultClaudeSessionForkSdk.readTranscript(
				sessionId,
				{ dir: projectDir, configDir },
			);
			expect(messages).toHaveLength(1);
			const fork = await defaultClaudeSessionForkSdk.forkSession(sessionId, {
				dir: projectDir,
				configDir,
				title: "Fork",
			});
			expect(existsSync(join(transcriptDir, `${fork.sessionId}.jsonl`))).toBe(
				true,
			);
			expect(process.env["CLAUDE_CONFIG_DIR"]).toBe(daemonEnv);
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});
