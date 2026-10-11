// Failure modes: remote spelling splits one repository; a lone project keeps a
// qualifier; an off override leaves stale qualifiers; monorepo packages merge
// under subfolder mode; non-git folders borrow another folder's identity; local
// checkouts split; attached folders change the group; identical titles collapse
// distinct projects; input order changes the label; composite keys collide.
import { describe, expect, it } from "vitest";
import { computeProjectGroups } from "../../src/lib/project-grouping.js";
import type {
	GroupingMode,
	RepositoryIdentity,
} from "../../src/lib/shared-types.js";

const project = (
	slug: string,
	folder = `/checkouts/${slug}`,
	groupingMode: GroupingMode = "repository",
	identity: RepositoryIdentity | undefined = {
		key: "github.com/owner/shared",
		name: "Shared",
		root: folder,
	},
) => ({
	slug,
	title: `${slug} checkout`,
	folders: [folder] as readonly [string],
	repositoryIdentities: identity ? { [folder]: identity } : {},
	groupingMode,
});

describe("Project Groups", () => {
	it("groups SSH and HTTPS clones by their canonical identity with one label and qualifiers", () => {
		const groups = computeProjectGroups([project("ssh"), project("https")]);
		expect(groups["ssh"]).toEqual(groups["https"]);
		expect(groups["ssh"]).toMatchObject({
			label: "Shared",
			needsProjectQualifier: true,
		});
	});

	it("never qualifies a lone project", () => {
		expect(computeProjectGroups([project("only")])["only"]).toMatchObject({
			label: "Shared",
			needsProjectQualifier: false,
		});
	});

	it("separates an off project and removes the remaining project's qualifier", () => {
		const groups = computeProjectGroups([
			project("ssh"),
			project("https", undefined, "off"),
		]);
		expect(groups["ssh"]?.key).not.toBe(groups["https"]?.key);
		expect(groups["ssh"]).toMatchObject({
			label: "Shared",
			needsProjectQualifier: false,
		});
		expect(groups["https"]).toMatchObject({
			label: "https checkout",
			needsProjectQualifier: false,
		});
	});

	it("separates monorepo packages by subfolder and groups them by repository", () => {
		const api = project("api", "/mono/packages/api", "repository+subfolder", {
			key: "github.com/owner/mono",
			name: "Mono",
			root: "/mono",
		});
		const web = project("web", "/mono/packages/web", "repository+subfolder", {
			key: "github.com/owner/mono",
			name: "Mono",
			root: "/mono",
		});
		const separated = computeProjectGroups([api, web]);
		expect(separated["api"]?.key).not.toBe(separated["web"]?.key);
		expect(Object.values(separated)).toEqual([
			expect.objectContaining({ label: "Mono", needsProjectQualifier: false }),
			expect.objectContaining({ label: "Mono", needsProjectQualifier: false }),
		]);
		const grouped = computeProjectGroups(
			[api, web].map((p) => ({ ...p, groupingMode: "repository" as const })),
		);
		expect(grouped["api"]).toEqual(grouped["web"]);
		expect(grouped["api"]?.needsProjectQualifier).toBe(true);
	});

	it("groups the same monorepo subfolder across different checkouts", () => {
		const input = ["first", "second"].map((slug) =>
			project(slug, `/${slug}/packages/api/`, "repository+subfolder", {
				key: "github.com/owner/mono",
				name: "Mono",
				root: `/${slug}`,
			}),
		);
		const groups = computeProjectGroups(input);
		expect(groups["first"]).toEqual(groups["second"]);
		expect(groups["first"]?.needsProjectQualifier).toBe(true);
	});

	it("keeps a non-git primary folder in its own group", () => {
		const scratch = { ...project("scratch"), repositoryIdentities: {} };
		const groups = computeProjectGroups([scratch, project("git")]);
		expect(groups["scratch"]?.key).not.toBe(groups["git"]?.key);
		expect(groups["scratch"]).toMatchObject({
			label: "scratch checkout",
			needsProjectQualifier: false,
		});
	});

	it("groups local checkouts by the shared common directory without a remote", () => {
		const groups = computeProjectGroups(
			["local", "linked"].map((slug) =>
				project(slug, `/${slug}`, "repository", {
					key: "/local/.git",
					name: "local",
					root: `/${slug}`,
				}),
			),
		);
		expect(groups["local"]).toEqual(groups["linked"]);
		expect(groups["local"]).toMatchObject({
			label: "local",
			needsProjectQualifier: true,
		});
	});

	it("ignores attached folders, including when the primary has no identity", () => {
		const main = project("main");
		const other = project("other");
		const attached = {
			...main,
			folders: [main.folders[0], "/secondary"] as const,
			repositoryIdentities: {
				...main.repositoryIdentities,
				"/secondary": {
					key: "github.com/owner/another",
					name: "Another",
					root: "/secondary",
				},
			},
		};
		expect(computeProjectGroups([attached, other])).toEqual(
			computeProjectGroups([main, other]),
		);
		const noPrimaryIdentity = {
			...attached,
			repositoryIdentities: {
				"/secondary": attached.repositoryIdentities["/secondary"],
			},
		};
		expect(
			computeProjectGroups([noPrimaryIdentity, other])["main"],
		).toMatchObject({
			label: "main checkout",
			needsProjectQualifier: false,
		});
	});

	it("counts distinct projects even when their titles are identical", () => {
		const groups = computeProjectGroups(
			[project("first"), project("second")].map((p) => ({
				...p,
				title: "Same",
			})),
		);
		expect(Object.keys(groups)).toHaveLength(2);
		expect(groups["first"]).toEqual(groups["second"]);
		expect(groups["first"]?.needsProjectQualifier).toBe(true);
	});

	it("chooses one display spelling independently of project order without mutating the input", () => {
		const first = project("a");
		const second = project("b", "/b", "repository", {
			key: "github.com/owner/shared",
			name: "SHARED",
			root: "/b",
		});
		const input = Object.freeze([Object.freeze(first), Object.freeze(second)]);
		expect(computeProjectGroups(input)).toEqual(
			computeProjectGroups([...input].reverse()),
		);
		expect(computeProjectGroups(input)["b"]?.label).toBe("Shared");
	});

	it("keeps standalone keys and repository/subfolder boundaries distinct", () => {
		const input = [
			project("github.com/owner/shared", undefined, "off"),
			project("root"),
			project("package", "/mono/b", "repository+subfolder", {
				key: "a",
				name: "A",
				root: "/mono",
			}),
			project("another", "/mono", "repository+subfolder", {
				key: "a/b",
				name: "B",
				root: "/mono",
			}),
		];
		expect(
			new Set(Object.values(computeProjectGroups(input)).map(({ key }) => key))
				.size,
		).toBe(4);
	});

	it("accepts an empty project list", () => {
		expect(computeProjectGroups([])).toEqual({});
	});
});
