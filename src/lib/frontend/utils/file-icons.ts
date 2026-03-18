// ─── File Icon Utilities ─────────────────────────────────────────────────────
// File type classification and icon helpers.
// file-icons-js is loaded via CDN; this wraps the global API.

declare const FileIcons:
	| { getClassWithColor(filename: string): string }
	| undefined;

/**
 * Get CSS class for a file icon (from file-icons-js CDN library).
 * Returns empty string if the library isn't loaded.
 */
export function getFileIconClass(filename: string): string {
	if (FileIcons?.getClassWithColor) {
		return FileIcons.getClassWithColor(filename) || "";
	}
	return "";
}

/** Check if a file is likely binary based on its extension. */
export function isBinaryFile(name: string): boolean {
	const binaryExts = new Set([
		".png",
		".jpg",
		".jpeg",
		".gif",
		".bmp",
		".ico",
		".webp",
		".svg",
		".pdf",
		".zip",
		".gz",
		".tar",
		".7z",
		".rar",
		".exe",
		".dll",
		".so",
		".dylib",
		".wasm",
		".bin",
		".dat",
		".db",
		".sqlite",
		".mp3",
		".mp4",
		".wav",
		".avi",
		".mov",
		".ttf",
		".otf",
		".woff",
		".woff2",
		".eot",
	]);
	const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
	return binaryExts.has(ext);
}

/** Check if a file/directory entry should be hidden by default. */
export function isHiddenEntry(name: string): boolean {
	return name.startsWith(".");
}

/** Check if a directory should be collapsed by default. */
export function shouldCollapseByDefault(name: string): boolean {
	const autoCollapse = new Set([
		"node_modules",
		".git",
		"dist",
		"build",
		"coverage",
		".svelte-kit",
		"__pycache__",
		".next",
		".nuxt",
		".cache",
	]);
	return autoCollapse.has(name);
}
