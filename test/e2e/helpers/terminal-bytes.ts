// Byte capture for the terminal keys E2E: what the program in a real PTY
// actually received, as hex.
//
// One raw-mode dump per test. The test drives many presses inside it, closing
// each group with a separator, then ends the dump with a marker. Both are
// typed as physical control keys no scenario sends (⌃\ and ⌃]), with no
// modifier locked, so they reach the dump untouched. The dump writes its hex
// to a file in the test's output dir: that file is the byte log artifact, and
// reading it avoids scraping wrapped rows off the screen.

import { readFile, writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";

const SEPARATOR = 0x1c;
const MARKER = 0x1d;

const DUMP_SCRIPT = `
import os, sys, termios, tty
out, modes = sys.argv[1], sys.argv[2:]
old = termios.tcgetattr(0)
tty.setraw(0)
on = "".join(f"\\x1b[?{m}h" for m in modes)
off = "".join(f"\\x1b[?{m}l" for m in modes)
sys.stdout.write(on + "BYTE-DUMP-READY")
sys.stdout.flush()
data = b""
try:
    while not data.endswith(bytes([${MARKER}])):
        data += os.read(0, 1024)
finally:
    termios.tcsetattr(0, termios.TCSADRAIN, old)
    sys.stdout.write(off + "\\r\\nBYTE-DUMP-DONE\\r\\n")
groups = data[:-1].split(bytes([${SEPARATOR}]))
open(out, "w").write("\\n".join(g.hex(" ") for g in groups))
`;

export type ByteDumpModes = {
	/** DECCKM: arrows send SS3 instead of CSI. */
	applicationCursor?: boolean;
	bracketedPaste?: boolean;
};

export type ByteDump = {
	/** Close the current group of presses. */
	group(): Promise<void>;
	/** Send the marker and return each group's bytes as spaced hex. */
	finish(): Promise<string[]>;
};

/** Start a dump in the active terminal tab, which must have focus. */
export async function startByteDump(
	page: Page,
	testInfo: TestInfo,
	modes: ByteDumpModes = {},
): Promise<ByteDump> {
	const script = testInfo.outputPath("byte-dump.py");
	const log = testInfo.outputPath("bytes.log");
	await writeFile(script, DUMP_SCRIPT);
	const modeArgs = [
		...(modes.applicationCursor ? ["1"] : []),
		...(modes.bracketedPaste ? ["2004"] : []),
	];
	// Hidden tabs keep their rows; only the active tab's are visible.
	const rows = page
		.locator("#terminal-panel .xterm-rows")
		.filter({ visible: true });
	await page.keyboard.type(
		`python3 '${script}' '${log}' ${modeArgs.join(" ")}`,
	);
	await page.keyboard.press("Enter");
	await expect(rows).toContainText("BYTE-DUMP-READY");

	return {
		group: () => page.keyboard.press("Control+Backslash"),
		async finish() {
			await page.keyboard.press("Control+BracketRight");
			await expect(rows).toContainText("BYTE-DUMP-DONE");
			const hex = await readFile(log, "utf8");
			await testInfo.attach("bytes.log", {
				path: log,
				contentType: "text/plain",
			});
			const screen = testInfo.outputPath("screen.png");
			await page.screenshot({ path: screen });
			await testInfo.attach("screen", {
				path: screen,
				contentType: "image/png",
			});
			return hex.split("\n");
		},
	};
}
