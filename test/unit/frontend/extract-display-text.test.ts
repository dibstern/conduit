// ─── extractDisplayText Tests ────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { extractDisplayText } from "../../../src/lib/frontend/utils/format.js";

describe("extractDisplayText", () => {
	it("returns original text when no XML wrapper", () => {
		expect(extractDisplayText("hello world")).toBe("hello world");
	});

	it("returns original text for empty string", () => {
		expect(extractDisplayText("")).toBe("");
	});

	it("extracts user-message content from XML wrapper", () => {
		const wrapped = `<attached-files>
<file path="src/auth.ts">
const x = 1;
</file>
</attached-files>

<user-message>
Explain @src/auth.ts
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("Explain @src/auth.ts");
	});

	it("handles multiple attached files", () => {
		const wrapped = `<attached-files>
<file path="a.ts">aaa</file>
<file path="b.ts">bbb</file>
</attached-files>

<user-message>
Compare @a.ts and @b.ts
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("Compare @a.ts and @b.ts");
	});

	it("handles directory attachments", () => {
		const wrapped = `<attached-files>
<directory path="src/utils/">
auth.ts (1.2KB, file)
helpers/ (directory)
</directory>
</attached-files>

<user-message>
List @src/utils/
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("List @src/utils/");
	});

	it("handles multiline user messages", () => {
		const wrapped = `<attached-files>
<file path="x.ts">code</file>
</attached-files>

<user-message>
Line one
Line two
Line three
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("Line one\nLine two\nLine three");
	});

	it("passes through text that contains < but is not our XML format", () => {
		const text = "Use a <div> element for layout";
		expect(extractDisplayText(text)).toBe(text);
	});

	it("handles binary file markers", () => {
		const wrapped = `<attached-files>
<file path="image.png" binary="true" />
</attached-files>

<user-message>
What is @image.png
</user-message>`;
		expect(extractDisplayText(wrapped)).toBe("What is @image.png");
	});
});
