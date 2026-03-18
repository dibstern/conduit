// ─── Svelte File Icons — Unit Tests ──────────────────────────────────────────
// Tests isBinaryFile, isHiddenEntry, shouldCollapseByDefault.

import { describe, expect, test } from "vitest";
import {
	isBinaryFile,
	isHiddenEntry,
	shouldCollapseByDefault,
} from "../../../src/lib/frontend/utils/file-icons.js";

// ─── isBinaryFile ────────────────────────────────────────────────────────────

describe("isBinaryFile", () => {
	describe("image formats", () => {
		test("detects .png as binary", () => {
			expect(isBinaryFile("photo.png")).toBe(true);
		});

		test("detects .jpg as binary", () => {
			expect(isBinaryFile("image.jpg")).toBe(true);
		});

		test("detects .jpeg as binary", () => {
			expect(isBinaryFile("image.jpeg")).toBe(true);
		});

		test("detects .gif as binary", () => {
			expect(isBinaryFile("animation.gif")).toBe(true);
		});

		test("detects .bmp as binary", () => {
			expect(isBinaryFile("bitmap.bmp")).toBe(true);
		});

		test("detects .ico as binary", () => {
			expect(isBinaryFile("favicon.ico")).toBe(true);
		});

		test("detects .webp as binary", () => {
			expect(isBinaryFile("modern.webp")).toBe(true);
		});

		test("detects .svg as binary", () => {
			expect(isBinaryFile("vector.svg")).toBe(true);
		});
	});

	describe("archive formats", () => {
		test("detects .zip as binary", () => {
			expect(isBinaryFile("archive.zip")).toBe(true);
		});

		test("detects .gz as binary", () => {
			expect(isBinaryFile("file.tar.gz")).toBe(true);
		});

		test("detects .tar as binary", () => {
			expect(isBinaryFile("archive.tar")).toBe(true);
		});

		test("detects .7z as binary", () => {
			expect(isBinaryFile("archive.7z")).toBe(true);
		});

		test("detects .rar as binary", () => {
			expect(isBinaryFile("archive.rar")).toBe(true);
		});
	});

	describe("executable and library formats", () => {
		test("detects .exe as binary", () => {
			expect(isBinaryFile("program.exe")).toBe(true);
		});

		test("detects .dll as binary", () => {
			expect(isBinaryFile("library.dll")).toBe(true);
		});

		test("detects .so as binary", () => {
			expect(isBinaryFile("libfoo.so")).toBe(true);
		});

		test("detects .dylib as binary", () => {
			expect(isBinaryFile("libbar.dylib")).toBe(true);
		});

		test("detects .wasm as binary", () => {
			expect(isBinaryFile("module.wasm")).toBe(true);
		});
	});

	describe("data formats", () => {
		test("detects .bin as binary", () => {
			expect(isBinaryFile("data.bin")).toBe(true);
		});

		test("detects .dat as binary", () => {
			expect(isBinaryFile("data.dat")).toBe(true);
		});

		test("detects .db as binary", () => {
			expect(isBinaryFile("store.db")).toBe(true);
		});

		test("detects .sqlite as binary", () => {
			expect(isBinaryFile("data.sqlite")).toBe(true);
		});

		test("detects .pdf as binary", () => {
			expect(isBinaryFile("document.pdf")).toBe(true);
		});
	});

	describe("media formats", () => {
		test("detects .mp3 as binary", () => {
			expect(isBinaryFile("song.mp3")).toBe(true);
		});

		test("detects .mp4 as binary", () => {
			expect(isBinaryFile("video.mp4")).toBe(true);
		});

		test("detects .wav as binary", () => {
			expect(isBinaryFile("audio.wav")).toBe(true);
		});

		test("detects .avi as binary", () => {
			expect(isBinaryFile("clip.avi")).toBe(true);
		});

		test("detects .mov as binary", () => {
			expect(isBinaryFile("movie.mov")).toBe(true);
		});
	});

	describe("font formats", () => {
		test("detects .ttf as binary", () => {
			expect(isBinaryFile("font.ttf")).toBe(true);
		});

		test("detects .otf as binary", () => {
			expect(isBinaryFile("font.otf")).toBe(true);
		});

		test("detects .woff as binary", () => {
			expect(isBinaryFile("font.woff")).toBe(true);
		});

		test("detects .woff2 as binary", () => {
			expect(isBinaryFile("font.woff2")).toBe(true);
		});

		test("detects .eot as binary", () => {
			expect(isBinaryFile("font.eot")).toBe(true);
		});
	});

	describe("text/source files are not binary", () => {
		test("detects .ts as not binary", () => {
			expect(isBinaryFile("index.ts")).toBe(false);
		});

		test("detects .js as not binary", () => {
			expect(isBinaryFile("app.js")).toBe(false);
		});

		test("detects .json as not binary", () => {
			expect(isBinaryFile("package.json")).toBe(false);
		});

		test("detects .md as not binary", () => {
			expect(isBinaryFile("README.md")).toBe(false);
		});

		test("detects .html as not binary", () => {
			expect(isBinaryFile("index.html")).toBe(false);
		});

		test("detects .css as not binary", () => {
			expect(isBinaryFile("style.css")).toBe(false);
		});

		test("detects .py as not binary", () => {
			expect(isBinaryFile("main.py")).toBe(false);
		});

		test("detects .txt as not binary", () => {
			expect(isBinaryFile("notes.txt")).toBe(false);
		});

		test("detects .yaml as not binary", () => {
			expect(isBinaryFile("config.yaml")).toBe(false);
		});
	});

	describe("case insensitivity", () => {
		test("detects .PNG (uppercase) as binary", () => {
			expect(isBinaryFile("photo.PNG")).toBe(true);
		});

		test("detects .Jpg (mixed case) as binary", () => {
			expect(isBinaryFile("image.Jpg")).toBe(true);
		});

		test("detects .WASM (uppercase) as binary", () => {
			expect(isBinaryFile("module.WASM")).toBe(true);
		});
	});
});

// ─── isHiddenEntry ───────────────────────────────────────────────────────────

describe("isHiddenEntry", () => {
	test("returns true for dotfiles", () => {
		expect(isHiddenEntry(".gitignore")).toBe(true);
	});

	test("returns true for dot directories", () => {
		expect(isHiddenEntry(".git")).toBe(true);
	});

	test("returns true for .env", () => {
		expect(isHiddenEntry(".env")).toBe(true);
	});

	test("returns true for .DS_Store", () => {
		expect(isHiddenEntry(".DS_Store")).toBe(true);
	});

	test("returns false for regular files", () => {
		expect(isHiddenEntry("index.ts")).toBe(false);
	});

	test("returns false for directories without leading dot", () => {
		expect(isHiddenEntry("src")).toBe(false);
	});

	test("returns false for files with dot in name but not leading", () => {
		expect(isHiddenEntry("my.file.txt")).toBe(false);
	});

	test("returns true for just a dot", () => {
		expect(isHiddenEntry(".")).toBe(true);
	});

	test("returns false for empty string", () => {
		expect(isHiddenEntry("")).toBe(false);
	});
});

// ─── shouldCollapseByDefault ─────────────────────────────────────────────────

describe("shouldCollapseByDefault", () => {
	test("collapses node_modules", () => {
		expect(shouldCollapseByDefault("node_modules")).toBe(true);
	});

	test("collapses .git", () => {
		expect(shouldCollapseByDefault(".git")).toBe(true);
	});

	test("collapses dist", () => {
		expect(shouldCollapseByDefault("dist")).toBe(true);
	});

	test("collapses build", () => {
		expect(shouldCollapseByDefault("build")).toBe(true);
	});

	test("collapses coverage", () => {
		expect(shouldCollapseByDefault("coverage")).toBe(true);
	});

	test("collapses .svelte-kit", () => {
		expect(shouldCollapseByDefault(".svelte-kit")).toBe(true);
	});

	test("collapses __pycache__", () => {
		expect(shouldCollapseByDefault("__pycache__")).toBe(true);
	});

	test("collapses .next", () => {
		expect(shouldCollapseByDefault(".next")).toBe(true);
	});

	test("collapses .nuxt", () => {
		expect(shouldCollapseByDefault(".nuxt")).toBe(true);
	});

	test("collapses .cache", () => {
		expect(shouldCollapseByDefault(".cache")).toBe(true);
	});

	test("does not collapse src", () => {
		expect(shouldCollapseByDefault("src")).toBe(false);
	});

	test("does not collapse lib", () => {
		expect(shouldCollapseByDefault("lib")).toBe(false);
	});

	test("does not collapse test", () => {
		expect(shouldCollapseByDefault("test")).toBe(false);
	});

	test("does not collapse components", () => {
		expect(shouldCollapseByDefault("components")).toBe(false);
	});

	test("does not collapse random name", () => {
		expect(shouldCollapseByDefault("my-project")).toBe(false);
	});

	test("is case-sensitive (Node_Modules is not collapsed)", () => {
		expect(shouldCollapseByDefault("Node_Modules")).toBe(false);
	});
});
