#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, "..");
const formulaTemplatePath = path.join(
	skillRoot,
	"templates/formula/executable-plan.formula.toml",
);
const rolesDir = path.join(skillRoot, "templates/roles");

function usage() {
	console.error(
		"Usage: render-plan-to-beads.cjs <plan-ir.json> <output.formula.toml>\n       render-plan-to-beads.cjs --schema",
	);
}

function escapeString(value) {
	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n");
}

function camelToSnake(value) {
	return String(value).replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function renderTomlValue(value) {
	if (value && typeof value === "object" && typeof value.__toml === "string") {
		return value.__toml;
	}
	if (Array.isArray(value)) {
		return `[${value.map(renderTomlValue).join(", ")}]`;
	}
	if (value && typeof value === "object") {
		const fields = Object.entries(value).map(
			([key, fieldValue]) => `${key} = ${renderTomlValue(fieldValue)}`,
		);
		return `{ ${fields.join(", ")} }`;
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number")
		return Number.isFinite(value) ? String(value) : "0";
	return `"${escapeString(value ?? "")}"`;
}

function defaultForPlaceholder(name) {
	if (name === "formula_version") return 1;
	if (name.endsWith("_bool")) return false;
	if (name.endsWith("_int")) return 0;
	if (
		name.endsWith("_array") ||
		name.endsWith("_arrays") ||
		name.endsWith("_array_of_tables")
	) {
		return [];
	}
	if (name.endsWith("_table") || name.endsWith("_object")) return {};
	return "";
}

function renderUnquotedPlaceholder(name, value) {
	const resolved = value === undefined ? defaultForPlaceholder(name) : value;
	if (
		typeof resolved === "string" &&
		/_(array|arrays|array_of_tables|table|object)$/.test(name)
	) {
		return resolved;
	}
	return renderTomlValue(resolved);
}

function renderTemplate(template, values) {
	return template
		.replace(/"([^"\n]*\{\{[a-z0-9_]+\}\}[^"\n]*)"/g, (_match, inner) => {
			const interpolated = inner.replace(
				/\{\{([a-z0-9_]+)\}\}/g,
				(_innerMatch, name) => {
					const value =
						values[name] === undefined
							? defaultForPlaceholder(name)
							: values[name];
					return escapeString(value);
				},
			);
			return `"${interpolated}"`;
		})
		.replace(/\{\{([a-z0-9_]+)\}\}/g, (_match, name) =>
			renderUnquotedPlaceholder(name, values[name]),
		);
}

function rootValues(ir) {
	return {
		formula_version: ir.formulaVersion ?? 1,
		plan_description: ir.planDescription ?? ir.description ?? "",
		plan_id: ir.planId ?? ir.plan_id ?? "",
		plan_title: ir.planTitle ?? ir.plan_title ?? "",
		source_plan: ir.sourcePlan ?? ir.source_plan ?? "",
		template_version:
			ir.templateVersion ?? ir.template_version ?? "plan-to-beads.v3",
	};
}

function roleValues(ir, role) {
	const values = {
		...rootValues(ir),
		...role,
		...(role.metadata ?? {}),
		...(role.values ?? {}),
	};

	for (const [key, value] of Object.entries(role)) {
		values[camelToSnake(key)] = value;
	}

	values.logical_id =
		role.logicalId ?? role.logical_id ?? values.logical_id ?? "";
	values.needs_array = role.needs ?? values.needs_array ?? [];
	values.context_refs_array =
		role.contextRefs ?? values.context_refs_array ?? [];
	values.inherits_array = role.inherits ?? values.inherits_array ?? [];
	values.typed_contract_refs_array =
		role.typedContractRefs ?? values.typed_contract_refs_array ?? [];
	values.provides_array = role.provides ?? values.provides_array ?? [];
	values.context_use_array_of_tables =
		role.contextUse ?? values.context_use_array_of_tables ?? [];

	return values;
}

function renderRole(ir, role) {
	const roleName = role.role;
	if (!roleName) throw new Error("Every role entry must include role.");

	const templatePath = path.join(rolesDir, `${roleName}.toml`);
	if (!fs.existsSync(templatePath)) {
		throw new Error(`No role template exists for role "${roleName}".`);
	}

	return renderTemplate(
		fs.readFileSync(templatePath, "utf8"),
		roleValues(ir, role),
	);
}

function renderFormula(ir) {
	const formulaTemplate = fs.readFileSync(formulaTemplatePath, "utf8");
	const roles = ir.roles ?? [];
	if (!Array.isArray(roles) || roles.length === 0) {
		throw new Error("Plan IR must include at least one role.");
	}

	const renderedRoles = roles.map((role) => renderRole(ir, role)).join("\n\n");
	return renderTemplate(
		formulaTemplate.replace("# {{rendered_role_steps}}", renderedRoles),
		rootValues(ir),
	);
}

function printSchema() {
	console.log(
		JSON.stringify(
			{
				planId: "short-stable-id",
				planTitle: "Human title",
				sourcePlan: "docs/plans/example.md",
				planDescription: "Short formula description",
				formulaVersion: 1,
				templateVersion: "plan-to-beads.v3",
				roles: [
					{
						role: "child",
						logicalId: "example-child-01",
						title: "Concrete behavior title",
						description: "One executable behavior.",
						needs: [],
						contextRefs: [],
						inherits: [],
						typedContractRefs: [],
						provides: [],
						contextUse: [],
						values: {},
					},
				],
			},
			null,
			2,
		),
	);
}

const args = process.argv.slice(2);
if (args[0] === "--schema") {
	printSchema();
	process.exit(0);
}

if (args.length !== 2) {
	usage();
	process.exit(1);
}

const [inputPath, outputPath] = args;
const ir = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const formula = renderFormula(ir);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, formula);
console.log(`rendered ${outputPath}`);
