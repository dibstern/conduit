import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { defaultClaudeSessionForkSdk } from "../../src/lib/provider/claude/claude-session-fork.js";
import type { ProjectRelayConfig } from "../../src/lib/types.js";
import { claudeSdk as fakeClaudeSdk } from "./fake-claude-process-sdk.js";

// The SDK trace capture keeps only Claude's output; live tests also need what was sent
// (each input's priority), so a capture dir also gets every streamed input in inputs.jsonl.
const captureDir = process.env["CONDUIT_CLAUDE_SDK_CAPTURE"];

async function* teeInputs(
	prompt: AsyncIterable<SDKUserMessage>,
	file: string,
): AsyncGenerator<SDKUserMessage> {
	for await (const message of prompt) {
		appendFileSync(file, `${JSON.stringify(message)}\n`);
		yield message;
	}
}

export const claudeSdk: NonNullable<ProjectRelayConfig["claudeSdk"]> = {
	query: captureDir
		? ({ prompt, options }) =>
				query({
					prompt:
						typeof prompt === "string"
							? prompt
							: teeInputs(prompt, join(captureDir, "inputs.jsonl")),
					...(options === undefined ? {} : { options }),
				})
		: query,
	titleQuery: fakeClaudeSdk.titleQuery,
	fork: defaultClaudeSessionForkSdk,
};
