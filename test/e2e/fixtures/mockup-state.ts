// ─── Mockup State Fixture ─────────────────────────────────────────────────────
// Canned WebSocket messages that reproduce the exact state shown in mockup.html.
//
// The mockup shows:
//   - Sidebar with sessions grouped by Today/Yesterday/This Week
//   - Turn 1 (completed): thinking → 3 tool calls → assistant markdown → metadata
//   - Turn 2 (in-progress): active thinking → 1 completed tool + 1 running tool
//   - Context info panel (35%, model claude-sonnet-4)
//   - Model selector showing "claude-sonnet-4"
//   - Header: project name, connected status, 2 clients
//
// Usage:
//   The WS mock helper sends "init" messages on connect, then "turn1" messages
//   after the first user message, then "turn2" after the second.

export interface MockMessage {
	type: string;
	[key: string]: unknown;
}

// ─── Initial connection state ─────────────────────────────────────────────────

export const initMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-mockup-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 2,
	},
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-mockup-001",
				title: "Fix model selector UI",
				updatedAt: Date.now(),
				messageCount: 4,
			},
			{
				id: "sess-mockup-002",
				title: "Add dark mode support",
				updatedAt: Date.now() - 3600_000,
				messageCount: 8,
			},
			{
				id: "sess-mockup-003",
				title: "Refactor WebSocket handler",
				updatedAt: Date.now() - 7200_000,
				messageCount: 12,
			},
			{
				id: "sess-mockup-004",
				title: "Implement file browser panel",
				updatedAt: Date.now() - 86400_000,
				messageCount: 6,
			},
			{
				id: "sess-mockup-005",
				title: "Add notification system",
				updatedAt: Date.now() - 100800_000,
				messageCount: 3,
			},
			{
				id: "sess-mockup-006",
				title: "Set up project structure",
				updatedAt: Date.now() - 345600_000,
				messageCount: 10,
			},
			{
				id: "sess-mockup-007",
				title: "Initial relay architecture",
				updatedAt: Date.now() - 432000_000,
				messageCount: 15,
			},
		],
	},
	{
		type: "model_list",
		providers: [
			{
				id: "anthropic",
				name: "Anthropic",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4",
						name: "claude-sonnet-4",
						provider: "anthropic",
					},
					{
						id: "claude-haiku-3.5",
						name: "claude-haiku-3.5",
						provider: "anthropic",
					},
				],
			},
		],
	},
	{
		type: "agent_list",
		agents: [
			{ id: "code", name: "Code", description: "General coding assistant" },
		],
	},
];

// ─── Turn 1 response (completed) ─────────────────────────────────────────────
// Sent after user message: "Help me implement a WebSocket handler for the relay server"

export const turn1Messages: MockMessage[] = [
	{ type: "status", status: "processing" },

	// Thinking block
	{ type: "thinking_start" },
	{
		type: "thinking_delta",
		text: "Let me look at the existing relay server code to understand the architecture before implementing the WebSocket handler.",
	},
	{ type: "thinking_stop" },

	// Tool: Read
	{ type: "tool_start", id: "call_read_1", name: "Read" },
	{
		type: "tool_executing",
		id: "call_read_1",
		name: "Read",
		input: { file_path: "src/lib/relay-stack.ts" },
	},
	{
		type: "tool_result",
		id: "call_read_1",
		content: "// relay-stack.ts content...",
		is_error: false,
	},

	// Tool: Grep
	{ type: "tool_start", id: "call_grep_1", name: "Grep" },
	{
		type: "tool_executing",
		id: "call_grep_1",
		name: "Grep",
		input: { pattern: "WebSocket.*handler" },
	},
	{
		type: "tool_result",
		id: "call_grep_1",
		content: "src/lib/server.ts:42: // WebSocket handler setup",
		is_error: false,
	},

	// Tool: Write
	{ type: "tool_start", id: "call_write_1", name: "Write" },
	{
		type: "tool_executing",
		id: "call_write_1",
		name: "Write",
		input: { file_path: "src/lib/ws-handler.ts" },
	},
	{
		type: "tool_result",
		id: "call_write_1",
		content: "File written successfully",
		is_error: false,
	},

	// Assistant response (markdown)
	{
		type: "delta",
		text: "I've implemented the WebSocket handler. Here's what I created:\n\n",
	},
	{
		type: "delta",
		text: "- **Connection management** — tracks connected clients with unique IDs\n",
	},
	{
		type: "delta",
		text: "- **Message routing** — broadcasts to all clients or sends to specific ones\n",
	},
	{
		type: "delta",
		text: "- **Auto-reconnect** — handles dropped connections gracefully\n\n",
	},
	{
		type: "delta",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: code example contains template literal
		text: 'The handler follows the same pattern as `claude-relay` but adapted for OpenCode\'s SSE event model:\n\n```typescript\nconst wsHandler = new WebSocketHandler(httpServer);\n\nwsHandler.on("client_connected", ({ clientId }) => {\n  log(`Client connected: ${clientId}`);\n});\n\nwsHandler.on("message", async ({ clientId, handler, payload }) => {\n  // Route messages to appropriate handlers\n});\n```',
	},

	// Turn metadata
	{
		type: "result",
		usage: { input: 1247, output: 892, cache_read: 0, cache_creation: 0 },
		cost: 0.0134,
		duration: 4200,
		sessionId: "sess-mockup-001",
	},

	{ type: "done", code: 0 },
	{ type: "status", status: "idle" },
];

// ─── Turn 2 response (in-progress) ──────────────────────────────────────────
// Sent after user message: "Now add model selection support"
// Note: This turn is intentionally left incomplete (no done/idle) to show
// active thinking and a running tool.

export const turn2Messages: MockMessage[] = [
	{ type: "status", status: "processing" },

	// Active thinking (no thinking_stop — stays pulsing)
	{ type: "thinking_start" },
	{
		type: "thinking_delta",
		text: "I need to add model selection support to the relay. Let me check the existing model UI code first.",
	},

	// Tool: Read (completed)
	{ type: "tool_start", id: "call_read_2", name: "Read" },
	{
		type: "tool_executing",
		id: "call_read_2",
		name: "Read",
		input: { file_path: "src/lib/frontend/model-ui.ts" },
	},
	{
		type: "tool_result",
		id: "call_read_2",
		content: "// model-ui.ts content...",
		is_error: false,
	},

	// Tool: Write (in-progress — no tool_result, stays spinning)
	{ type: "tool_start", id: "call_write_2", name: "Write" },
	{
		type: "tool_executing",
		id: "call_write_2",
		name: "Write",
		input: { file_path: "src/lib/relay-stack.ts" },
	},
	// Intentionally NO tool_result — this tool stays in "running" state
];

// ─── User message texts ─────────────────────────────────────────────────────

export const userMessage1 =
	"Help me implement a WebSocket handler for the relay server";
export const userMessage2 = "Now add model selection support";

// ─── Multi-Instance Fixtures ─────────────────────────────────────────────────
// Canned messages for testing multi-instance UI features.

/** Two instances: "personal" (healthy) and "work" (unhealthy) */
export const multiInstanceList: MockMessage = {
	type: "instance_list",
	instances: [
		{
			id: "personal",
			name: "Personal",
			port: 4096,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: Date.now() - 86400_000,
		},
		{
			id: "work",
			name: "Work",
			port: 4097,
			managed: true,
			status: "unhealthy",
			restartCount: 2,
			createdAt: Date.now() - 43200_000,
		},
	],
};

/** Single default instance (healthy) */
export const singleInstanceList: MockMessage = {
	type: "instance_list",
	instances: [
		{
			id: "default",
			name: "Default",
			port: 4096,
			managed: true,
			status: "healthy",
			restartCount: 0,
			createdAt: Date.now(),
		},
	],
};

/** Status update: "work" becomes healthy */
export const workInstanceHealthy: MockMessage = {
	type: "instance_status",
	instanceId: "work",
	status: "healthy",
};

/** Status update: "personal" becomes unhealthy */
export const personalInstanceUnhealthy: MockMessage = {
	type: "instance_status",
	instanceId: "personal",
	status: "unhealthy",
};

/** Status update: "work" becomes stopped */
export const workInstanceStopped: MockMessage = {
	type: "instance_status",
	instanceId: "work",
	status: "stopped",
};

/** Status update: "work" becomes starting */
export const workInstanceStarting: MockMessage = {
	type: "instance_status",
	instanceId: "work",
	status: "starting",
};

/** Project list with instanceId bindings — use with multi-instance init */
export const multiInstanceProjectList: MockMessage = {
	type: "project_list",
	projects: [
		{
			slug: "myapp",
			title: "myapp",
			directory: "/src/myapp",
			instanceId: "personal",
		},
		{
			slug: "mylib",
			title: "mylib",
			directory: "/src/mylib",
			instanceId: "personal",
		},
		{
			slug: "company-api",
			title: "company-api",
			directory: "/src/company-api",
			instanceId: "work",
		},
	],
	current: "myapp",
};

/** Project list with single instance — projects have no instanceId */
export const singleInstanceProjectList: MockMessage = {
	type: "project_list",
	projects: [
		{
			slug: "myapp",
			title: "myapp",
			directory: "/src/myapp",
		},
		{
			slug: "mylib",
			title: "mylib",
			directory: "/src/mylib",
		},
	],
	current: "myapp",
};

/** Empty instance list (for Getting Started panel tests) */
export const emptyInstanceList: MockMessage = {
	type: "instance_list",
	instances: [],
};

/** Init messages with no instances (for Getting Started panel tests) */
export const noInstanceInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-ni-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-ni-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	emptyInstanceList,
	singleInstanceProjectList,
];

/** Init messages for multi-instance testing (session + model + instances + projects) */
export const multiInstanceInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-mi-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-mi-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	multiInstanceList,
	multiInstanceProjectList,
];

/** Init messages for single-instance testing */
export const singleInstanceInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-si-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-si-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	singleInstanceList,
	singleInstanceProjectList,
];

// ─── Variant / thinking-level test fixtures ──────────────────────────────────

/** Model list with variants (thinking levels) on one model. */
export const variantModelList: MockMessage = {
	type: "model_list",
	providers: [
		{
			id: "anthropic",
			name: "Anthropic",
			configured: true,
			models: [
				{
					id: "claude-opus-4-6",
					name: "claude-opus-4-6",
					provider: "anthropic",
					variants: ["low", "medium", "high", "max"],
				},
				{
					id: "claude-sonnet-4",
					name: "claude-sonnet-4",
					provider: "anthropic",
				},
			],
		},
	],
};

/** Project list for variant tests (single project, no instanceId). */
const variantProjectList: MockMessage = {
	type: "project_list",
	projects: [
		{
			slug: "myapp",
			title: "myapp",
			directory: "/src/myapp",
		},
	],
	current: "myapp",
};

/** Init messages for variant testing — model with thinking-level variants. */
export const variantInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-var-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-opus-4-6",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-var-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	variantModelList,
	{
		type: "agent_list",
		agents: [
			{ id: "code", name: "Code", description: "General coding assistant" },
		],
	},
	{
		type: "variant_info",
		variant: "",
		variants: ["low", "medium", "high", "max"],
	},
	variantProjectList,
];

/** Init messages for variant testing — model WITHOUT thinking-level variants. */
export const noVariantInitMessages: MockMessage[] = [
	{
		type: "session_switched",
		id: "sess-novar-001",
	},
	{
		type: "status",
		status: "idle",
	},
	{
		type: "model_info",
		model: "claude-sonnet-4",
		provider: "anthropic",
	},
	{
		type: "client_count",
		count: 1,
	},
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-novar-001",
				title: "Test session",
				updatedAt: Date.now(),
				messageCount: 0,
			},
		],
	},
	variantModelList,
	{
		type: "agent_list",
		agents: [
			{ id: "code", name: "Code", description: "General coding assistant" },
		],
	},
	{
		type: "variant_info",
		variant: "",
		variants: [],
	},
	variantProjectList,
];
