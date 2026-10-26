// Failure cases: trailing slash vs none, bare "~", "/", paths outside home,
// home itself, a partial last segment, several or zero matches, case differences,
// double slashes, invalid home prefixes, dot segments, and non-child entries.
import { describe, expect, it } from "vitest";
import {
	ghost,
	parseFolderQuery,
} from "../../src/lib/frontend/components/project/folder-query.js";

const home = "/Users/a";

describe("parseFolderQuery", () => {
	it("leaves plain search queries out of browse mode", () => {
		expect(parseFolderQuery("personal", home)).toEqual({
			isPath: false,
			folder: undefined,
			crumbs: [],
			upQuery: undefined,
		});
	});

	it("lists a trailing-slash folder and builds home-relative crumbs", () => {
		expect(parseFolderQuery("~/src/personal/", home)).toEqual({
			isPath: true,
			folder: `${home}/src/personal`,
			crumbs: [
				{ label: "~", query: "~/" },
				{ label: "src", query: "~/src/" },
				{ label: "personal", query: "~/src/personal/" },
			],
			upQuery: "~/src/",
		});
	});

	it("lists the parent when the last segment has no trailing slash", () => {
		expect(parseFolderQuery("~/src/personal", home)).toEqual(
			parseFolderQuery("~/src/per", home),
		);
		expect(parseFolderQuery("~/src/per", home)).toEqual({
			isPath: true,
			folder: `${home}/src`,
			crumbs: [
				{ label: "~", query: "~/" },
				{ label: "src", query: "~/src/" },
			],
			upQuery: "~/",
		});
	});

	it.each(["~", "~/", `${home}/`])("recognizes home itself: %s", (query) => {
		expect(parseFolderQuery(query, home)).toEqual({
			isPath: true,
			folder: home,
			crumbs: [{ label: "~", query: "~/" }],
			upQuery: undefined,
		});
	});

	it("handles the filesystem root without a parent", () => {
		expect(parseFolderQuery("/", home)).toEqual({
			isPath: true,
			folder: "/",
			crumbs: [{ label: "/", query: "/" }],
			upQuery: undefined,
		});
	});

	it("uses root crumbs outside home and respects the home path boundary", () => {
		expect(parseFolderQuery("/Users/ab/", home)).toEqual({
			isPath: true,
			folder: "/Users/ab",
			crumbs: [
				{ label: "/", query: "/" },
				{ label: "Users", query: "/Users/" },
				{ label: "ab", query: "/Users/ab/" },
			],
			upQuery: "/Users/",
		});
	});

	it("shortens absolute paths under home and normalizes repeated slashes", () => {
		expect(parseFolderQuery(`${home}//src///personal//`, `${home}/`)).toEqual(
			parseFolderQuery("~/src/personal/", home),
		);
		expect(parseFolderQuery("//", home)).toEqual(parseFolderQuery("/", home));
	});

	it("normalizes dot segments without leaving the root", () => {
		expect(parseFolderQuery("~/src/../personal/./", home)).toEqual(
			parseFolderQuery("~/personal/", home),
		);
		expect(parseFolderQuery("/../../", home).folder).toBe("/");
	});

	it("keeps malformed or unresolved home queries in browse mode without a folder", () => {
		expect(parseFolderQuery("~someone/src/", home)).toEqual({
			isPath: true,
			folder: undefined,
			crumbs: [],
			upQuery: undefined,
		});
		expect(parseFolderQuery("~/src/", "").folder).toBeUndefined();
	});
});

describe("ghost", () => {
	const entries = [
		{ path: `${home}/src/personal` },
		{ path: `${home}/src/work` },
	];
	it("completes a unique partial child with a trailing slash", () => {
		expect(ghost("~/src/per", entries, home)).toBe("sonal/");
		expect(ghost(`${home}/src/per`, entries, home)).toBe("sonal/");
		expect(ghost("~/src/personal", entries, home)).toBe("/");
	});
	it("matches case-insensitively while preserving the completion's case", () => {
		expect(ghost("~/src/PE", [{ path: `${home}/src/Personal` }], home)).toBe(
			"rsonal/",
		);
	});
	it("does not complete ambiguous or absent matches", () => {
		expect(
			ghost("~/src/per", [...entries, { path: `${home}/src/personas` }], home),
		).toBe("");
		expect(ghost("~/src/no", entries, home)).toBe("");
		expect(ghost("~/src/per", [], home)).toBe("");
	});
	it.each([
		"personal",
		"~",
		"~/",
		"/",
		"~/src/",
		"~someone/per",
	])("does not complete an empty or invalid last segment: %s", (query) => {
		expect(ghost(query, entries, home)).toBe("");
	});
	it("normalizes double slashes and completes outside home", () => {
		expect(ghost("~//src//per", entries, home)).toBe("sonal/");
		expect(ghost("/opt/pro", [{ path: "/opt/projects/" }], home)).toBe(
			"jects/",
		);
	});
	it("ignores parents, nested descendants, and entries from other folders", () => {
		expect(
			ghost(
				"~/src/per",
				[
					{ path: `${home}/src` },
					{ path: `${home}/src/personal/notes` },
					{ path: "/other/personal" },
				],
				home,
			),
		).toBe("");
	});
});
