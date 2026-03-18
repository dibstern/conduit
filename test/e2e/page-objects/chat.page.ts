import type { Locator, Page } from "@playwright/test";

export class ChatPage {
	readonly page: Page;
	readonly messagesContainer: Locator;
	readonly userMessages: Locator;
	readonly assistantMessages: Locator;
	readonly thinkingBlocks: Locator;
	readonly codeBlocks: Locator;
	readonly codeCopyBtns: Locator;
	readonly toolBlocks: Locator;
	readonly resultBars: Locator;
	readonly stopBtn: Locator;
	readonly subagentBackBar: Locator;
	readonly subagentBackBtn: Locator;
	readonly subagentLinks: Locator;
	readonly subagentCards: Locator;

	constructor(page: Page) {
		this.page = page;
		this.messagesContainer = page.locator("#messages");
		this.userMessages = page.locator(".msg-user");
		this.assistantMessages = page.locator(".msg-assistant");
		this.thinkingBlocks = page.locator(".thinking-block");
		this.codeBlocks = page.locator("pre code");
		this.codeCopyBtns = page.locator(".code-copy-btn");
		this.toolBlocks = page.locator(".tool-item");
		this.resultBars = page.locator(".result-bar");
		this.stopBtn = page.locator("#stop");
		this.subagentBackBar = page.locator(".subagent-back-bar");
		this.subagentBackBtn = page.locator(".subagent-back-btn");
		this.subagentLinks = page.locator(".subagent-link");
		this.subagentCards = page.locator(".subagent-header");
	}

	async waitForUserMessage(text: string): Promise<Locator> {
		const msg = this.page.locator(".msg-user .bubble", { hasText: text });
		await msg.waitFor({ state: "visible", timeout: 5_000 });
		return msg;
	}

	/**
	 * Wait for an assistant message with actual rendered content.
	 * Uses .md-content with non-empty innerHTML to ensure the response has been rendered.
	 */
	async waitForAssistantMessage(timeout?: number): Promise<Locator> {
		const t = timeout ?? 60_000;
		const contentLocator = this.page.locator(
			".msg-assistant .md-content:not(:empty)",
		);
		await contentLocator.last().waitFor({ state: "visible", timeout: t });
		return this.assistantMessages.last();
	}

	async getLastAssistantText(): Promise<string> {
		const content = this.assistantMessages.last().locator(".md-content");
		await content.waitFor({ state: "visible", timeout: 30_000 });
		return content.innerText();
	}

	/**
	 * Wait for streaming/processing to complete.
	 * The #stop button is a separate element that is only rendered while processing.
	 * We wait for it to disappear (or confirm it was never visible).
	 */
	async waitForStreamingComplete(timeout?: number): Promise<void> {
		const t = timeout ?? 90_000;
		// The #stop button is conditionally rendered ({#if isProcessing}).
		// If it's currently visible, wait for it to disappear.
		// If it's already hidden (fast response), this resolves immediately.
		await this.stopBtn.waitFor({ state: "hidden", timeout: t });
	}

	async getUserMessageCount(): Promise<number> {
		return this.userMessages.count();
	}

	async getAssistantMessageCount(): Promise<number> {
		return this.assistantMessages.count();
	}

	/** Wait for at least one tool block to appear */
	async waitForToolBlock(timeout = 60_000): Promise<Locator> {
		const tool = this.toolBlocks.first();
		await tool.waitFor({ state: "visible", timeout });
		return tool;
	}

	/** Wait for a tool to reach completed state (subtitle shows "Done" or "Answered") */
	async waitForToolCompleted(timeout = 60_000): Promise<void> {
		const completedSubtitle = this.page.locator(".tool-subtitle-text", {
			hasText: /^Done$|^Answered/,
		});
		await completedSubtitle.first().waitFor({ state: "visible", timeout });
	}

	/** Get count of tool blocks */
	async getToolBlockCount(): Promise<number> {
		return this.toolBlocks.count();
	}

	/** Wait for result bar to appear after a response completes */
	async waitForResultBar(timeout = 60_000): Promise<Locator> {
		const bar = this.resultBars.last();
		await bar.waitFor({ state: "visible", timeout });
		return bar;
	}

	/** Get the text content of the last result bar */
	async getResultBarText(): Promise<string> {
		const bar = this.resultBars.last();
		await bar.waitFor({ state: "visible", timeout: 30_000 });
		return bar.innerText();
	}

	/** Wait for a thinking block to appear */
	async waitForThinkingBlock(timeout = 60_000): Promise<Locator> {
		const thinking = this.thinkingBlocks.first();
		await thinking.waitFor({ state: "visible", timeout });
		return thinking;
	}

	/** Check if the stop button is currently visible (processing in progress) */
	async isProcessing(): Promise<boolean> {
		return this.stopBtn.isVisible();
	}
}
