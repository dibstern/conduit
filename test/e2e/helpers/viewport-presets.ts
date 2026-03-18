// ─── Viewport Presets ────────────────────────────────────────────────────────
// 5 viewport definitions matching the Playwright config projects.

export const VIEWPORTS = {
	"iphone-15": { width: 393, height: 852, isMobile: true, hasTouch: true },
	"iphone-17": { width: 402, height: 874, isMobile: true, hasTouch: true },
	"pixel-7": { width: 412, height: 915, isMobile: true, hasTouch: true },
	"ipad-pro-11": { width: 834, height: 1194, isMobile: false, hasTouch: true },
	desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
} as const;

export type ViewportName = keyof typeof VIEWPORTS;

export function isMobileViewport(width: number): boolean {
	return width < 769;
}

export function isTabletViewport(width: number): boolean {
	return width >= 769 && width < 1024;
}

export function isDesktopViewport(width: number): boolean {
	return width >= 1024;
}
