import type { Locator, Page } from "@playwright/test";

export class ModalPage {
	readonly page: Page;
	readonly confirmModal: Locator;
	readonly imageLightbox: Locator;
	readonly rewindModal: Locator;
	readonly qrOverlay: Locator;

	constructor(page: Page) {
		this.page = page;
		this.confirmModal = page.locator("#confirm-modal");
		this.imageLightbox = page.locator("#image-lightbox");
		this.rewindModal = page.locator("#rewind-modal");
		this.qrOverlay = page.locator("#qr-overlay");
	}

	async isConfirmVisible(): Promise<boolean> {
		return !(await this.confirmModal.evaluate((el) =>
			el.classList.contains("hidden"),
		));
	}

	async confirmAction(): Promise<void> {
		await this.confirmModal.locator(".confirm-action-btn").click();
	}

	async cancelAction(): Promise<void> {
		await this.confirmModal.locator(".confirm-cancel-btn").click();
	}

	async pressEscape(): Promise<void> {
		await this.page.keyboard.press("Escape");
	}

	async isQrOverlayVisible(): Promise<boolean> {
		return !(await this.qrOverlay.evaluate((el) =>
			el.classList.contains("hidden"),
		));
	}
}
