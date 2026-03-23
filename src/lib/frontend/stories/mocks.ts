/**
 * Shared mock data for Storybook stories.
 * Reused across all story files to ensure consistency.
 */

import type {
	AssistantMessage,
	ResultMessage,
	SessionInfo,
	SystemMessage,
	ThinkingMessage,
	ToolMessage,
	UserMessage,
} from "../types.js";

// ─── Sessions ────────────────────────────────────────────────────────────────

export const mockSession: SessionInfo = {
	id: "sess_01JTEST000000000000000001",
	title: "Test Session",
	createdAt: "2026-02-24T10:00:00Z",
	updatedAt: "2026-02-24T10:30:00Z",
	messageCount: 12,
	processing: false,
};

export const mockSessionProcessing: SessionInfo = {
	id: "sess_01JTEST000000000000000004",
	title: "Running CI pipeline checks",
	createdAt: "2026-02-25T08:00:00Z",
	updatedAt: "2026-02-25T08:05:00Z",
	messageCount: 3,
	processing: true,
};

export const mockSessionLongTitle: SessionInfo = {
	id: "sess_01JTEST000000000000000005",
	title:
		"Investigate memory leak in production WebSocket connection handler that causes OOM after 48 hours",
	createdAt: "2026-02-25T07:00:00Z",
	updatedAt: "2026-02-25T07:30:00Z",
	messageCount: 45,
	processing: false,
};

export const mockSessions: SessionInfo[] = [
	mockSession,
	{
		id: "sess_01JTEST000000000000000002",
		title: "Debug authentication flow",
		createdAt: "2026-02-24T09:00:00Z",
		updatedAt: "2026-02-24T09:45:00Z",
		messageCount: 8,
		processing: false,
	},
	{
		id: "sess_01JTEST000000000000000003",
		title: "Refactor database queries",
		createdAt: "2026-02-23T14:00:00Z",
		updatedAt: "2026-02-23T15:20:00Z",
		messageCount: 22,
		processing: true,
	},
];

/** Sessions spanning all three date groups (today, yesterday, older). */
export const mockSessionsAllGroups: SessionInfo[] = [
	{
		id: "sess_01JTEST000000000000000010",
		title: "Fix WebSocket reconnection",
		createdAt: "2026-02-25T10:00:00Z",
		updatedAt: "2026-02-25T10:30:00Z",
		messageCount: 5,
		processing: false,
	},
	mockSessionProcessing,
	{
		id: "sess_01JTEST000000000000000011",
		title: "Add dark mode support",
		createdAt: "2026-02-24T14:00:00Z",
		updatedAt: "2026-02-24T15:00:00Z",
		messageCount: 18,
		processing: false,
	},
	{
		id: "sess_01JTEST000000000000000012",
		title: "Review PR #42",
		createdAt: "2026-02-24T09:00:00Z",
		updatedAt: "2026-02-24T09:30:00Z",
		messageCount: 6,
		processing: false,
	},
	{
		id: "sess_01JTEST000000000000000013",
		title: "Set up CI pipeline",
		createdAt: "2026-02-20T10:00:00Z",
		updatedAt: "2026-02-20T12:00:00Z",
		messageCount: 34,
		processing: false,
	},
	{
		id: "sess_01JTEST000000000000000014",
		title: "Initial project scaffolding",
		createdAt: "2026-02-18T08:00:00Z",
		updatedAt: "2026-02-18T11:00:00Z",
		messageCount: 15,
		processing: false,
	},
];

// ─── User Messages ───────────────────────────────────────────────────────────

export const mockUserMessage: UserMessage = {
	type: "user",
	uuid: "msg-user-001",
	text: "How do I fix the authentication bug?",
};

export const mockUserMessageLong: UserMessage = {
	type: "user",
	uuid: "msg-user-002",
	text: "I'm having an issue with the authentication flow in our application. When a user logs in with valid credentials, the session token is created correctly, but after about 15 minutes the token seems to expire and the user gets logged out unexpectedly. I've checked the token expiry settings and they look correct. Can you help me debug this?",
};

export const mockUserMessageShort: UserMessage = {
	type: "user",
	uuid: "msg-user-003",
	text: "Fix the bug",
};

// ─── Assistant Messages ──────────────────────────────────────────────────────

export const mockAssistantSimple: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-001",
	rawText: "I can help with that. Let me look at the authentication module.",
	html: "<p>I can help with that. Let me look at the authentication module.</p>",
	finalized: true,
};

export const mockAssistantWithCode: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-002",
	rawText:
		"The issue is in the token refresh logic. Here's the fix:\n\n```typescript\nconst refreshToken = async () => {\n  const response = await fetch('/api/refresh', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ token: getStoredToken() }),\n  });\n  if (!response.ok) throw new Error('Refresh failed');\n  return response.json();\n};\n```\n\nThis should fix the expiry issue.",
	html: "<p>The issue is in the token refresh logic. Here's the fix:</p>\n<pre><code class=\"language-typescript\">const refreshToken = async () =&gt; {\n  const response = await fetch('/api/refresh', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ token: getStoredToken() }),\n  });\n  if (!response.ok) throw new Error('Refresh failed');\n  return response.json();\n};\n</code></pre>\n<p>This should fix the expiry issue.</p>",
	finalized: true,
};

export const mockAssistantWithMultipleCodeBlocks: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-003",
	rawText:
		'First, update the model:\n\n```python\nclass User:\n    def __init__(self, name: str):\n        self.name = name\n```\n\nThen the view:\n\n```python\n@app.route("/users")\ndef list_users():\n    return jsonify(users)\n```\n\nAnd add a test:\n\n```python\ndef test_list_users(client):\n    resp = client.get("/users")\n    assert resp.status_code == 200\n```',
	html: '<p>First, update the model:</p>\n<pre><code class="language-python">class User:\n    def __init__(self, name: str):\n        self.name = name\n</code></pre>\n<p>Then the view:</p>\n<pre><code class="language-python">@app.route("/users")\ndef list_users():\n    return jsonify(users)\n</code></pre>\n<p>And add a test:</p>\n<pre><code class="language-python">def test_list_users(client):\n    resp = client.get("/users")\n    assert resp.status_code == 200\n</code></pre>',
	finalized: true,
};

export const mockAssistantStreaming: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-004",
	rawText: "I'm looking at the code now and I can see the issue. The token",
	html: "<p>I'm looking at the code now and I can see the issue. The token</p>",
	finalized: false,
};

export const mockAssistantWithMermaid: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-005",
	rawText:
		"Here's the authentication flow:\n\n```mermaid\ngraph LR\n    A[Client] --> B[Auth Server]\n    B --> C{Valid?}\n    C -->|Yes| D[Token]\n    C -->|No| E[Error]\n```\n\nAs you can see, the flow is straightforward.",
	html: '<p>Here\'s the authentication flow:</p>\n<pre><code class="language-mermaid">graph LR\n    A[Client] --&gt; B[Auth Server]\n    B --&gt; C{Valid?}\n    C --&gt;|Yes| D[Token]\n    C --&gt;|No| E[Error]\n</code></pre>\n<p>As you can see, the flow is straightforward.</p>',
	finalized: true,
};

export const mockAssistantEmpty: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-006",
	rawText: "",
	html: "",
	finalized: false,
};

export const mockAssistantMarkdown: AssistantMessage = {
	type: "assistant",
	uuid: "msg-asst-007",
	rawText:
		"Here are the key findings:\n\n1. **Token expiry** is set to 15 minutes\n2. *Refresh logic* has a race condition\n3. The `localStorage` key is ~~wrong~~ correct\n\n> Note: This only affects production.\n\n| Setting | Value | Status |\n|---------|-------|--------|\n| TTL | 900s | ✅ |\n| Refresh | auto | ❌ |\n| Secure | true | ✅ |",
	html: "<p>Here are the key findings:</p>\n<ol>\n<li><strong>Token expiry</strong> is set to 15 minutes</li>\n<li><em>Refresh logic</em> has a race condition</li>\n<li>The <code>localStorage</code> key is <del>wrong</del> correct</li>\n</ol>\n<blockquote><p>Note: This only affects production.</p></blockquote>\n<table>\n<thead><tr><th>Setting</th><th>Value</th><th>Status</th></tr></thead>\n<tbody>\n<tr><td>TTL</td><td>900s</td><td>✅</td></tr>\n<tr><td>Refresh</td><td>auto</td><td>❌</td></tr>\n<tr><td>Secure</td><td>true</td><td>✅</td></tr>\n</tbody></table>",
	finalized: true,
};

// ─── Thinking Messages ───────────────────────────────────────────────────────

export const mockThinkingActive: ThinkingMessage = {
	type: "thinking",
	uuid: "msg-think-001",
	text: "Let me analyze the authentication flow to identify the root cause of the token expiry issue...",
	done: false,
};

export const mockThinkingDone: ThinkingMessage = {
	type: "thinking",
	uuid: "msg-think-002",
	text: "I've analyzed the authentication flow. The issue is that the refresh token endpoint doesn't extend the session when called within the last 2 minutes of expiry.",
	duration: 3200,
	done: true,
};

export const mockThinkingLong: ThinkingMessage = {
	type: "thinking",
	uuid: "msg-think-003",
	text: "I need to consider multiple factors here:\n1. The token lifecycle\n2. The refresh mechanism\n3. The race condition between concurrent requests\n4. The session store cleanup timing\n5. Edge cases with clock skew\n\nAfter careful analysis, the root cause is...",
	duration: 12500,
	done: true,
};

// ─── Tool Messages ───────────────────────────────────────────────────────────

export const mockToolPending: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-001",
	id: "tool-001",
	name: "Read",
	status: "pending",
	input: { filePath: "/home/user/repo/src/auth.ts" },
};

export const mockToolRunning: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-002",
	id: "tool-002",
	name: "Edit",
	status: "running",
	input: {
		filePath: "/home/user/repo/src/auth.ts",
		oldString: "old",
		newString: "new",
	},
};

export const mockToolCompleted: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-003",
	id: "tool-003",
	name: "Read",
	status: "completed",
	input: { filePath: "/home/user/repo/src/auth.ts" },
	result:
		"export function authenticate(token: string): boolean {\n  const decoded = jwt.verify(token, SECRET);\n  return decoded.exp > Date.now() / 1000;\n}",
	isError: false,
};

export const mockToolError: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-004",
	id: "tool-004",
	name: "Bash",
	status: "error",
	input: { command: "cat /src/auth.ts", description: "Read auth module" },
	result:
		"Error: ENOENT: no such file or directory, open '/src/auth.ts'\n  at Object.openSync (node:fs:603:3)\n  at readFileSync (node:fs:471:35)",
	isError: true,
};

export const mockToolWithDiff: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-005",
	id: "tool-005",
	name: "Edit",
	status: "completed",
	input: {
		filePath: "/home/user/repo/src/auth.ts",
		oldString: "const ttl = 900; // 15 min",
		newString: "const ttl = 3600; // 1 hour",
	},
	result:
		"--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -15,7 +15,7 @@\n export function refreshToken(token: string) {\n-  const ttl = 900; // 15 min\n+  const ttl = 3600; // 1 hour\n   return jwt.sign(payload, SECRET, { expiresIn: ttl });\n }",
	isError: false,
};

export const mockToolLongResult: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-006",
	id: "tool-006",
	name: "Glob",
	status: "completed",
	input: { pattern: "src/components/**/*.ts" },
	result: Array.from(
		{ length: 30 },
		(_, i) => `src/components/Component${i + 1}.ts`,
	).join("\n"),
	isError: false,
};

export const mockToolBash: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-007",
	id: "tool-007",
	name: "Bash",
	status: "completed",
	input: {
		command: "git rev-parse HEAD",
		description: "Get base SHA for reviews",
	},
	result: "c14c4da090bb9b35ae2b716d44a9d0d6fa9bf112",
	isError: false,
};

export const mockToolReadWithOffset: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-008",
	id: "tool-008",
	name: "Read",
	status: "completed",
	input: { filePath: "/home/user/repo/src/model.ts", offset: 82, limit: 10 },
	result: "// model code here...",
	isError: false,
};

export const mockToolSubagent: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-subagent-001",
	id: "tool-subagent-001",
	name: "Task",
	status: "running",
	input: {
		description: "Explore test infrastructure",
		subagent_type: "explore",
		prompt: "Search for all test files...",
	},
};

export const mockToolSubagentCompleted: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-subagent-002",
	id: "tool-subagent-002",
	name: "Task",
	status: "completed",
	input: {
		description: "Implement feature X",
		subagent_type: "general",
		prompt: "Build the component...",
	},
	result: "task_id: ses_abc123\n\nCompleted implementation of feature X.",
	isError: false,
};

// ─── Question Tool Messages ──────────────────────────────────────────────────

export const mockQuestionRunning: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-q-001",
	id: "tool-q-001",
	name: "AskUserQuestion",
	status: "running",
	input: {
		questions: [
			{
				header: "model selection",
				question: "Which model would you like to use for this task?",
				options: [
					{
						label: "Yes, fix it (Recommended)",
						description:
							"Reset the timeout on each SSE event, turning it into an inactivity timeout",
					},
					{
						label: "More details first",
						description: "Explain more about the scenarios before proceeding",
					},
				],
				multiple: false,
				custom: true,
			},
		],
	},
};

export const mockQuestionAnswered: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-q-002",
	id: "tool-q-002",
	name: "AskUserQuestion",
	status: "completed",
	input: {
		questions: [
			{
				header: "deployment target",
				question: "Where should this be deployed?",
				options: [
					{ label: "Production" },
					{ label: "Staging" },
					{ label: "Development" },
				],
				multiple: false,
				custom: true,
			},
		],
	},
	result: '["Yes, fix it (Recommended)"]',
	isError: false,
};

export const mockQuestionSkipped: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-q-003",
	id: "tool-q-003",
	name: "AskUserQuestion",
	status: "error",
	input: {
		questions: [
			{
				header: "confirmation",
				question: "Shall I proceed with the refactor?",
				options: [{ label: "Yes" }, { label: "No" }],
				multiple: false,
				custom: false,
			},
		],
	},
	result: "Question was dismissed",
	isError: true,
};

export const mockQuestionPending: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-q-004",
	id: "tool-q-004",
	name: "AskUserQuestion",
	status: "pending",
};

// ─── Result Messages ─────────────────────────────────────────────────────────

export const mockResultFull: ResultMessage = {
	type: "result",
	uuid: "msg-result-001",
	cost: 0.0142,
	duration: 8500,
	inputTokens: 1250,
	outputTokens: 380,
	cacheRead: 800,
};

export const mockResultNoCost: ResultMessage = {
	type: "result",
	uuid: "msg-result-002",
	duration: 4200,
	inputTokens: 600,
	outputTokens: 150,
};

export const mockResultMinimal: ResultMessage = {
	type: "result",
	uuid: "msg-result-003",
	cost: 0.0003,
	duration: 1200,
};

export const mockResultExpensive: ResultMessage = {
	type: "result",
	uuid: "msg-result-004",
	cost: 0.2847,
	duration: 45000,
	inputTokens: 28000,
	outputTokens: 4200,
	cacheRead: 15000,
};

// ─── System Messages ─────────────────────────────────────────────────────────

export const mockSystemInfo: SystemMessage = {
	type: "system",
	uuid: "msg-sys-001",
	text: "Session restored from history",
	variant: "info",
};

export const mockSystemError: SystemMessage = {
	type: "system",
	uuid: "msg-sys-002",
	text: "Connection lost. Reconnecting...",
	variant: "error",
};

// ─── File Tree ───────────────────────────────────────────────────────────────

export const mockFileTree = [
	{
		name: "src",
		type: "directory" as const,
		children: [
			{ name: "main.ts", type: "file" as const },
			{ name: "utils.ts", type: "file" as const },
			{
				name: "components",
				type: "directory" as const,
				children: [
					{ name: "Header.svelte", type: "file" as const },
					{ name: "Sidebar.svelte", type: "file" as const },
				],
			},
		],
	},
	{ name: "package.json", type: "file" as const },
	{ name: "README.md", type: "file" as const },
];

// ─── Terminal ────────────────────────────────────────────────────────────────

export const mockTerminalOutput =
	"\x1b[32m$\x1b[0m pnpm test\n\n \x1b[32m✓\x1b[0m src/utils.test.ts (3 tests) 45ms\n \x1b[32m✓\x1b[0m src/main.test.ts (5 tests) 120ms\n\n\x1b[32m Tests  8 passed\x1b[0m\n\x1b[2m Duration  210ms\x1b[0m\n";

// ─── Conversation (mixed messages) ──────────────────────────────────────────

export const mockConversation = [
	mockUserMessage,
	mockThinkingDone,
	mockToolCompleted,
	mockAssistantWithCode,
	mockResultFull,
	mockUserMessageShort,
	mockToolRunning,
	mockAssistantStreaming,
];
