import { describe, expect, it } from "vitest";
import {
	type SkillSegment,
	tokenizeSkills,
} from "../../../src/lib/frontend/components/input/skill-highlight.js";

const known = new Set(["effect-ts", "code-review", "commit", "rn-eng:verify"]);

/** Reconstructing the text from segments must always be lossless. */
function joined(segs: SkillSegment[]): string {
	return segs.map((s) => s.text).join("");
}

function kinds(segs: SkillSegment[]): Array<[string, SkillSegment["kind"]]> {
	return segs.map((s) => [s.text, s.kind]);
}

describe("tokenizeSkills", () => {
	it("returns a single text segment when there are no slash tokens", () => {
		const segs = tokenizeSkills("just some plain text", known);
		expect(kinds(segs)).toEqual([["just some plain text", "text"]]);
	});

	it("marks a known skill as `skill` and preserves surrounding text", () => {
		const segs = tokenizeSkills("Refactor with /effect-ts please", known);
		expect(kinds(segs)).toEqual([
			["Refactor with ", "text"],
			["/effect-ts", "skill"],
			[" please", "text"],
		]);
		expect(joined(segs)).toBe("Refactor with /effect-ts please");
	});

	it.each([
		"/comit",
		"/commti",
		"/Commit",
	])("marks the near-miss slash token %s as `unknown`", (token) => {
		expect(kinds(tokenizeSkills(token, known))).toEqual([[token, "unknown"]]);
	});

	it.each([
		"/tmp",
		"/usr",
		"/opt",
		"/etc",
		"/Users",
	])("treats the absolute-path root %s as text in command positions", (root) => {
		expect(kinds(tokenizeSkills(root, known))).toEqual([[root, "text"]]);
		expect(kinds(tokenizeSkills(`open ${root}`, known))).toEqual([
			["open ", "text"],
			[root, "text"],
		]);
	});

	it.each([
		"/bogus",
		"/nonsense",
		"/qwerty",
	])("treats the arbitrary slash token %s as text", (token) => {
		expect(kinds(tokenizeSkills(token, known))).toEqual([[token, "text"]]);
	});

	it.each([
		"/commi",
		"/comm",
		"/effect-t",
	])("treats the proper command prefix %s as text", (token) => {
		expect(kinds(tokenizeSkills(token, known))).toEqual([[token, "text"]]);
	});

	it("recognises a token at the very start of the input", () => {
		const segs = tokenizeSkills("/commit the change", known);
		expect(segs[0]).toMatchObject({ text: "/commit", kind: "skill" });
	});

	it("recognises a token at the start of a later line", () => {
		const segs = tokenizeSkills("first line\n/commit now", known);
		expect(kinds(segs)).toEqual([
			["first line\n", "text"],
			["/commit", "skill"],
			[" now", "text"],
		]);
	});

	it("ignores file paths (slash followed by another slash)", () => {
		const segs = tokenizeSkills("open /etc/hosts and /src/lib/x", known);
		expect(segs.every((s) => s.kind === "text")).toBe(true);
		expect(joined(segs)).toBe("open /etc/hosts and /src/lib/x");
	});

	it("does not treat a mid-word slash as a token (URLs, and/or)", () => {
		const segs = tokenizeSkills("see https://x.com and/or foo", known);
		expect(segs.every((s) => s.kind === "text")).toBe(true);
	});

	it("supports namespaced (colon) skill names", () => {
		const segs = tokenizeSkills("run /rn-eng:verify soon", known);
		expect(segs[1]).toMatchObject({ text: "/rn-eng:verify", kind: "skill" });
	});

	it("stops the token at trailing punctuation so it still matches", () => {
		const segs = tokenizeSkills("do /commit, then stop", known);
		expect(kinds(segs)).toEqual([
			["do ", "text"],
			["/commit", "skill"],
			[", then stop", "text"],
		]);
	});

	it("gives repeated tokens distinct keys via occurrence index", () => {
		const segs = tokenizeSkills("/commit and /commit", known);
		const skillKeys = segs.filter((s) => s.kind === "skill").map((s) => s.key);
		expect(skillKeys).toEqual(["skill:commit:0", "skill:commit:1"]);
	});

	it("keys change when a token transitions from text to skill (drives shimmer)", () => {
		const partial = tokenizeSkills("/comm", known)[0];
		const complete = tokenizeSkills("/commit", known)[0];
		expect(partial?.key).toBe("text:comm:0");
		expect(complete?.key).toBe("skill:commit:0");
	});
});
