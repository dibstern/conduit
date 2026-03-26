// ─── Shared TypeScript Types ──────────────────────────────────────────────────
// All types used across Svelte stores and components.
// Single source of truth — import from here, not from vanilla modules.

// ─── Re-exports from shared-types ────────────────────────────────────────────
// These types are shared between server and frontend. Re-exported so
// frontend code can import everything from "./types.js".
// Types also used locally in this file are imported separately.

import type {
	AskUserQuestion,
	FileEntry,
	HistoryMessage,
	ModelInfo,
	PermissionId,
	ProviderInfo,
	SessionInfo,
	ToolStatus,
} from "../shared-types.js";

export type { PayloadMap } from "../handlers/payloads.js";

export type {
	AgentInfo,
	AskUserQuestion,
	CommandInfo,
	FileEntry,
	FileVersion,
	HistoryMessage,
	HistoryMessagePart,
	InstanceStatus,
	ModelInfo,
	OpenCodeInstance,
	PartType,
	PermissionId,
	ProjectInfo,
	ProviderInfo,
	PtyInfo,
	PtyStatus,
	RelayMessage,
	RequestId,
	SessionInfo,
	TodoItem,
	TodoStatus,
	ToolName,
	ToolStatus,
	UsageInfo,
} from "../shared-types.js";

// ─── Derived type aliases ────────────────────────────────────────────────────

/** Cost breakdown for a model (derived from shared ModelInfo). */
export type ModelCost = NonNullable<ModelInfo["cost"]>;

// ─── File Browser Types (frontend extensions) ────────────────────────────────

/** FileEntry with recursive children — for tree views that embed child nodes. */
export interface FileTreeEntry extends FileEntry {
	children?: FileTreeEntry[];
}

// ─── Chat Message Types ──────────────────────────────────────────────────────

export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| ThinkingMessage
	| ToolMessage
	| ResultMessage
	| SystemMessage;

export interface UserMessage {
	type: "user";
	uuid: string;
	text: string;
	images?: string[];
	/** The `turnEpoch` at which this message was sent, present only when it
	 *  was sent while the LLM was already processing (queued server-side).
	 *  Write-once / immutable — set in `addUserMessage`, never mutated.
	 *  The UI derives the "Queued" shimmer reactively:
	 *    `sentDuringEpoch != null && turnEpoch <= sentDuringEpoch`
	 *  The shimmer clears automatically when `handleDone` increments `turnEpoch`. */
	sentDuringEpoch?: number;
}

export interface AssistantMessage {
	type: "assistant";
	uuid: string;
	rawText: string;
	html: string;
	finalized: boolean;
	messageId?: string;
	needsRender?: boolean;
}

export interface ThinkingMessage {
	type: "thinking";
	uuid: string;
	text: string;
	duration?: number;
	done: boolean;
}

export interface ToolMessage {
	type: "tool";
	uuid: string;
	id: string;
	name: string;
	/** Tool input parameters — stored for tools that need rich rendering (e.g. task/subagent). */
	input?: unknown;
	status: ToolStatus;
	result?: string;
	isError?: boolean;
	isTruncated?: boolean;
	fullContentLength?: number;
	/** Tool part metadata — carries sessionId for Task/subagent tools. */
	metadata?: Record<string, unknown>;
	messageId?: string;
}

export interface ResultMessage {
	type: "result";
	uuid: string;
	cost?: number;
	duration?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type SystemMessageVariant = "info" | "error";

export interface SystemMessage {
	type: "system";
	uuid: string;
	text: string;
	variant?: SystemMessageVariant;
	errorCode?: string;
	statusCode?: number;
	details?: Record<string, unknown>;
}

// ─── Session Types (frontend-only) ──────────────────────────────────────────

export interface DateGroups {
	today: SessionInfo[];
	yesterday: SessionInfo[];
	older: SessionInfo[];
}

// ─── Terminal Types ──────────────────────────────────────────────────────────

export interface TerminalAdapter {
	mount(container: HTMLElement): void;
	write(data: string): void;
	onData(cb: (data: string) => void): void;
	onResize(cb: (size: { cols: number; rows: number }) => void): void;
	resize(): { cols: number; rows: number };
	focus(): void;
	dispose(): void;
	scrollLines(n: number): void;
	setFontSize(px: number): { cols: number; rows: number };
	setTheme(theme: Record<string, string>): void;
	readonly cols: number;
	readonly rows: number;
}

export interface TabEntry {
	ptyId: string;
	title: string;
	exited: boolean;
}

// ─── Discovery Types (frontend-only) ────────────────────────────────────────

export interface ProviderGroup {
	provider: ProviderInfo;
	models: ModelInfo[];
}

// ─── File Browser Types ──────────────────────────────────────────────────────

export interface BreadcrumbSegment {
	label: string;
	path: string;
}

// ─── Permission Types ────────────────────────────────────────────────────────

export interface PermissionRequest {
	requestId: PermissionId;
	sessionId: string;
	toolName: string;
	toolInput?: Record<string, unknown>;
	toolUseId?: string;
	always?: string[]; // Suggested patterns for "always" scope
}

// ─── Question Types ──────────────────────────────────────────────────────────

export interface QuestionRequest {
	toolId: string;
	/** Which session owns this question. */
	sessionId: string;
	/** The tool-use callID (toolu_ ID) that triggered this question.
	 *  Matches the ToolMessage.id in the chat timeline, allowing the frontend
	 *  to reliably link a pending question to its ToolItem. */
	toolUseId?: string;
	questions: AskUserQuestion[];
}

// ─── History Types ───────────────────────────────────────────────────────────

// HistoryMessage and HistoryMessagePart are re-exported from shared-types.ts above.

export interface Turn {
	user?: HistoryMessage;
	assistant?: HistoryMessage;
}

// ─── Toast Types ─────────────────────────────────────────────────────────────

export type ToastVariant = "default" | "warn";

export interface Toast {
	id: string;
	message: string;
	variant: ToastVariant;
	duration: number;
}

// ─── Banner Types ────────────────────────────────────────────────────────────

export type BannerVariant =
	| "update"
	| "onboarding"
	| "skip-permissions"
	| "warning";

export interface BannerConfig {
	id: string;
	variant: BannerVariant;
	icon: string;
	text: string;
	dismissible: boolean;
	version?: string;
}

// ─── Info Panel Types ────────────────────────────────────────────────────────

export type PanelId = "usage-panel" | "status-panel" | "context-panel";

export interface UsageData {
	cost?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	turns?: number;
}

export interface StatusData {
	pid?: number;
	uptime?: number;
	memory?: number;
	activeSessions?: number;
	processingSessions?: number;
	clients?: number;
	terminals?: number;
}

export interface ContextData {
	usedTokens?: number;
	windowSize?: number;
	maxOutput?: number;
	model?: string;
	cost?: number;
	turns?: number;
}

// ─── Notification Types ──────────────────────────────────────────────────────

export interface NotifSettings {
	push: boolean;
	browser: boolean;
	sound: boolean;
}

// ─── Todo Types (frontend-only) ──────────────────────────────────────────────

export interface TodoProgress {
	completed: number;
	total: number;
	percentage: number;
}

// ─── Diff Types ──────────────────────────────────────────────────────────────

export interface DiffOp {
	type: "add" | "remove" | "equal";
	line: string;
	oldLineNo?: number;
	newLineNo?: number;
}

export interface SplitRow {
	type: "add" | "remove" | "equal" | "change";
	oldLineNo: number | null;
	oldLine: string | null;
	newLineNo: number | null;
	newLine: string | null;
}

// ─── File History Types ──────────────────────────────────────────────────────

// FileVersion is re-exported from shared-types.ts above.

// ─── Project Types ───────────────────────────────────────────────────────────

// ProjectInfo is re-exported from shared-types.ts above.

// ─── Paste Types ─────────────────────────────────────────────────────────────

export interface PendingImage {
	id: string;
	dataUrl: string;
	name: string;
	size: number;
}

// ─── Plan Mode Types ─────────────────────────────────────────────────────────

export interface PlanApproval {
	onApprove: () => void;
	onReject: () => void;
}

// ─── Connection Status ───────────────────────────────────────────────────────

export type ConnectionStatus =
	| "connected"
	| "connecting"
	| "processing"
	| "error"
	| "disconnected"
	| "";
