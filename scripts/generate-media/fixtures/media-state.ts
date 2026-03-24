// ─── Media State Fixtures ─────────────────────────────────────────────────────
// Type-safe WebSocket mock messages for all 5 README media scenes.
//
// Each export corresponds to a scene module (Tasks 3–6) and provides the
// canned message arrays consumed by mockRelayWebSocket().

import type {
	PermissionId,
	RelayMessage,
} from "../../../src/lib/shared-types.js";
import type { MockMessage } from "../../../test/e2e/fixtures/mockup-state.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Compile-time validation wrapper — ensures all messages satisfy RelayMessage. */
function msgs(...messages: RelayMessage[]): MockMessage[] {
	return messages as MockMessage[];
}

// ─── Shared (not exported) ──────────────────────────────────────────────────

const modelList: RelayMessage = {
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
};

const agentList: RelayMessage = {
	type: "agent_list",
	agents: [
		{ id: "code", name: "Code", description: "General coding assistant" },
	],
};

// ─── Main UI Scene ──────────────────────────────────────────────────────────

export const mainUiInit: MockMessage[] = msgs(
	{ type: "session_switched", id: "sess-media-001" },
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-media-001",
				title: "Build landing page",
				updatedAt: Date.now(),
				messageCount: 6,
			},
			{
				id: "sess-media-002",
				title: "Fix mobile layout",
				updatedAt: Date.now() - 3600_000,
				messageCount: 4,
			},
			{
				id: "sess-media-003",
				title: "Add contact form",
				updatedAt: Date.now() - 7200_000,
				messageCount: 8,
			},
		],
	},
	modelList,
	agentList,
);

export const mainUiTurn1: MockMessage[] = msgs(
	// Start processing
	{ type: "status", status: "processing" },

	// Thinking block
	{ type: "thinking_start" },
	{
		type: "thinking_delta",
		text: "I'll create the landing page with a hero section, feature cards, and a footer. Let me read the existing HTML first.",
	},
	{ type: "thinking_stop" },

	// Tool: Read src/pages/index.html
	{ type: "tool_start", id: "call_read_1", name: "Read" },
	{
		type: "tool_executing",
		id: "call_read_1",
		name: "Read",
		input: { file_path: "src/pages/index.html" } as Record<string, unknown>,
	},
	{
		type: "tool_result",
		id: "call_read_1",
		content: "<!-- existing index.html content -->",
		is_error: false,
	},

	// Tool: Write src/pages/index.html
	{ type: "tool_start", id: "call_write_1", name: "Write" },
	{
		type: "tool_executing",
		id: "call_write_1",
		name: "Write",
		input: { file_path: "src/pages/index.html" } as Record<string, unknown>,
	},
	{
		type: "tool_result",
		id: "call_write_1",
		content: "File written successfully",
		is_error: false,
	},

	// Tool: Write src/styles/landing.css
	{ type: "tool_start", id: "call_write_2", name: "Write" },
	{
		type: "tool_executing",
		id: "call_write_2",
		name: "Write",
		input: { file_path: "src/styles/landing.css" } as Record<string, unknown>,
	},
	{
		type: "tool_result",
		id: "call_write_2",
		content: "File written successfully",
		is_error: false,
	},

	// Assistant response — hero / features / footer
	{
		type: "delta",
		text: "I've built the landing page with three main sections:\n\n",
	},
	{
		type: "delta",
		text: "- **Hero section** — gradient background with headline and CTA button\n",
	},
	{
		type: "delta",
		text: "- **Features grid** — three cards highlighting key capabilities\n",
	},
	{
		type: "delta",
		text: "- **Footer** — navigation links, social icons, and copyright\n\n",
	},
	{
		type: "delta",
		text: "The styles use CSS custom properties for theming and include responsive breakpoints for mobile.\n",
	},

	// Turn metadata
	{
		type: "result",
		usage: { input: 1580, output: 1124, cache_read: 0, cache_creation: 0 },
		cost: 0.0187,
		duration: 5400,
		sessionId: "sess-media-001",
	},

	{ type: "done", code: 0 },
	{ type: "status", status: "idle" },
);

// ─── Approval Scene ─────────────────────────────────────────────────────────

export const approvalInit: MockMessage[] = msgs(
	{ type: "session_switched", id: "sess-media-approval" },
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-media-approval",
				title: "Deploy to production",
				updatedAt: Date.now(),
				messageCount: 2,
			},
		],
	},
	modelList,
	agentList,
);

export const approvalPermission: MockMessage = {
	type: "permission_request",
	sessionId: "sess-media-approval",
	requestId: "perm-media-001" as PermissionId,
	toolName: "Bash",
	toolInput: { command: "npm run build && npm run deploy" },
	always: ["npm run *"],
} satisfies RelayMessage as MockMessage;

// ─── Dashboard Scene ────────────────────────────────────────────────────────

export const dashboardProjects = [
	{
		slug: "saas-landing",
		path: "/Users/dev/projects/saas-landing",
		title: "SaaS Landing Page",
		status: "ready" as const,
		sessions: 3,
		clients: 1,
		isProcessing: false,
	},
	{
		slug: "api-server",
		path: "/Users/dev/projects/api-server",
		title: "API Server",
		status: "ready" as const,
		sessions: 5,
		clients: 2,
		isProcessing: true,
	},
	{
		slug: "mobile-app",
		path: "/Users/dev/projects/mobile-app",
		title: "Mobile App",
		status: "ready" as const,
		sessions: 2,
		clients: 0,
		isProcessing: false,
	},
	{
		slug: "docs-site",
		path: "/Users/dev/projects/docs-site",
		title: "Documentation Site",
		status: "ready" as const,
		sessions: 1,
		clients: 1,
		isProcessing: false,
	},
];

// ─── Setup Scene ────────────────────────────────────────────────────────────

export const setupInfo = {
	httpsUrl: "https://192.168.1.42:2634",
	httpUrl: "http://192.168.1.42:2633",
	hasCert: false,
	lanMode: false,
};

// ─── Split Scene ────────────────────────────────────────────────────────────

export const splitInit: MockMessage[] = msgs(
	{ type: "session_switched", id: "sess-media-split" },
	{ type: "status", status: "idle" },
	{ type: "model_info", model: "claude-sonnet-4", provider: "anthropic" },
	{ type: "client_count", count: 1 },
	{
		type: "session_list",
		roots: true,
		sessions: [
			{
				id: "sess-media-split",
				title: "Build landing page",
				updatedAt: Date.now(),
				messageCount: 4,
			},
		],
	},
	modelList,
	agentList,
);

export const splitResponse: MockMessage[] = msgs(
	// Thinking
	{ type: "thinking_start" },
	{
		type: "thinking_delta",
		text: "I'll create a gradient hero section with a bold headline and call-to-action. Let me check the current markup first.",
	},
	{ type: "thinking_stop" },

	// Tool: Read index.html
	{ type: "tool_start", id: "call_split_read", name: "Read" },
	{
		type: "tool_executing",
		id: "call_split_read",
		name: "Read",
		input: { file_path: "index.html" } as Record<string, unknown>,
	},
	{
		type: "tool_result",
		id: "call_split_read",
		content: "<!DOCTYPE html>\n<html>...</html>",
		is_error: false,
	},

	// Tool: Write index.html
	{ type: "tool_start", id: "call_split_write", name: "Write" },
	{
		type: "tool_executing",
		id: "call_split_write",
		name: "Write",
		input: { file_path: "index.html" } as Record<string, unknown>,
	},
	{
		type: "tool_result",
		id: "call_split_write",
		content: "File written successfully",
		is_error: false,
	},

	// Assistant response — gradient / layout / CTA
	{
		type: "delta",
		text: "I've updated the landing page with:\n\n",
	},
	{
		type: "delta",
		text: "- **Gradient hero** — purple-to-blue gradient with animated background\n",
	},
	{
		type: "delta",
		text: "- **Responsive layout** — CSS Grid with fluid typography\n",
	},
	{
		type: "delta",
		text: "- **CTA button** — high-contrast button with hover animation\n",
	},

	// Turn metadata
	{
		type: "result",
		usage: { input: 920, output: 680, cache_read: 0, cache_creation: 0 },
		cost: 0.0098,
		duration: 3200,
		sessionId: "sess-media-split",
	},

	{ type: "done", code: 0 },
	{ type: "status", status: "idle" },
);
