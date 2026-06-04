#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const skillRoot = path.resolve(__dirname, "..");
const formulaTemplatePath = path.join(
	skillRoot,
	"templates/formula/executable-plan.formula.toml",
);
const rolesDir = path.join(skillRoot, "templates/roles");
const roleTemplateCache = new Map();

const typedContractFieldByKind = {
	amendmentLedger: "amendment_ledgers_array_of_tables",
	archiveProvenance: "archive_provenance_array_of_tables",
	artifactContract: "artifact_contracts_array_of_tables",
	auditFinding: "audit_findings_array_of_tables",
	boundaryClassification: "boundary_classifications_array_of_tables",
	completedSlice: "completed_slices_array_of_tables",
	conditionalBranch: "conditional_branches_array_of_tables",
	configContract: "config_contracts_array_of_tables",
	crossPlanRelationship: "cross_plan_relationships_array_of_tables",
	evidenceRun: "evidence_runs_array_of_tables",
	executorProfile: "executor_profiles_array_of_tables",
	historicalStatus: "historical_status_array_of_tables",
	inventorySnapshot: "inventory_snapshots_array_of_tables",
	manualAcceptance: "manual_acceptance_array_of_tables",
	moduleMap: "module_maps_array_of_tables",
	nonActionableFinding: "non_actionable_findings_array_of_tables",
	operatorSmoke: "operator_smoke_array_of_tables",
	planEdit: "plan_edits_array_of_tables",
	priorArt: "prior_art_array_of_tables",
	progressEntry: "progress_entries_array_of_tables",
	protocolContract: "protocol_contracts_array_of_tables",
	referencePattern: "reference_patterns_array_of_tables",
	residualDebt: "residual_debt_array_of_tables",
	reviewDisposition: "review_dispositions_array_of_tables",
	reviewRun: "review_runs_array_of_tables",
	runbook: "runbooks_array_of_tables",
	sourceAuthority: "source_authorities_array_of_tables",
	sourceGrounding: "source_grounding_array_of_tables",
	statusOverlay: "status_overlays_array_of_tables",
};

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

function roleTemplate(roleName) {
	if (!roleTemplateCache.has(roleName)) {
		const templatePath = path.join(rolesDir, `${roleName}.toml`);
		if (!fs.existsSync(templatePath)) {
			throw new Error(`No role template exists for role "${roleName}".`);
		}
		roleTemplateCache.set(roleName, fs.readFileSync(templatePath, "utf8"));
	}
	return roleTemplateCache.get(roleName);
}

function asArray(value) {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

function mergeUnique(a, b) {
	return Array.from(new Set([...asArray(a), ...asArray(b)].filter(Boolean)));
}

function typedContractField(contract) {
	const explicit =
		contract.targetField ?? contract.target_field ?? contract.field;
	if (explicit) return explicit;
	const kind = contract.kind;
	const field = typedContractFieldByKind[kind];
	if (!field) {
		throw new Error(
			`typedContract "${contract.logicalId ?? contract.logical_id ?? "<unknown>"}" has unsupported kind "${kind}"; add targetField.`,
		);
	}
	return field;
}

function typedContractEntry(contract) {
	const metadata = contract.metadata ?? {};
	const entry = {
		logicalId: contract.logicalId ?? contract.logical_id ?? "",
		kind: contract.kind ?? "",
		...metadata,
	};
	if (contract.provides) entry.provides = contract.provides;
	return entry;
}

function rolesWithTypedContracts(ir) {
	const roles = (ir.roles ?? []).map((role) => ({
		...role,
		values: { ...(role.values ?? {}) },
	}));
	const byLogicalId = new Map(
		roles.map((role) => [role.logicalId ?? role.logical_id, role]),
	);

	for (const contract of ir.typedContracts ?? ir.typed_contracts ?? []) {
		const ownerId = contract.ownerLogicalId ?? contract.owner_logical_id;
		const owner = byLogicalId.get(ownerId);
		if (!owner) {
			throw new Error(
				`typedContract "${contract.logicalId ?? contract.logical_id ?? "<unknown>"}" owner "${ownerId}" does not match any role logicalId.`,
			);
		}

		const field = typedContractField(contract);
		const template = roleTemplate(owner.role);
		if (!template.includes(`{{${field}}}`)) {
			throw new Error(
				`typedContract "${contract.logicalId ?? contract.logical_id ?? "<unknown>"}" targets "${field}", but role "${owner.role}" does not render that field.`,
			);
		}

		owner.values[field] = [
			...asArray(owner.values[field] ?? owner.metadata?.[field]),
			typedContractEntry(contract),
		];
		owner.provides = mergeUnique(
			owner.provides,
			contract.provides ?? [contract.logicalId ?? contract.logical_id],
		);
	}

	return roles;
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

	return renderTemplate(roleTemplate(roleName), roleValues(ir, role));
}

function renderFormula(ir) {
	const formulaTemplate = fs.readFileSync(formulaTemplatePath, "utf8");
	const roles = rolesWithTypedContracts(ir);
	if (!Array.isArray(roles) || roles.length === 0) {
		throw new Error("Plan IR must include at least one role.");
	}

	const renderedRoles = roles.map((role) => renderRole(ir, role)).join("\n\n");
	return renderTemplate(
		formulaTemplate.replace("# {{rendered_role_steps}}", renderedRoles),
		rootValues(ir),
	);
}

function minimalExampleIr() {
	return {
		planId: "example-plan",
		planTitle: "Example Plan",
		sourcePlan: "docs/plans/example-plan.md",
		planDescription: "Minimal valid plan-to-beads IR.",
		formulaVersion: 1,
		templateVersion: "plan-to-beads.v3",
		typedContracts: [
			{
				logicalId: "example-artifact-contract",
				kind: "artifactContract",
				ownerLogicalId: "example-architecture",
				targetField: "artifact_contracts_array_of_tables",
				provides: ["example-artifact-contract"],
				metadata: {
					artifact: "Example JSON report",
					schemaVersion: "v1",
					format: "json",
					fieldRules: [
						{
							field: "generatedAt",
							rule: "Stable timestamp string.",
						},
					],
				},
			},
		],
		roles: [
			{
				role: "epic",
				logicalId: "example-epic",
				title: "Example Plan",
				description: "Root plan molecule.",
				provides: ["example-epic"],
			},
			{
				role: "global-contract",
				logicalId: "example-global-contract",
				title: "Example scope",
				description: "Scope and non-goals.",
				provides: ["example-global-contract"],
				values: {
					scope_array: ["Add generatedAt to JSON reports."],
					non_goals_array: ["Do not change text output."],
				},
			},
			{
				role: "architecture",
				logicalId: "example-architecture",
				title: "Example architecture",
				description: "ReportWriter owns the JSON output contract.",
				contextRefs: ["example-global-contract"],
				provides: ["example-architecture"],
			},
			{
				role: "parent",
				logicalId: "example-stage",
				title: "Example implementation stage",
				description: "Stage defaults for one behavior.",
				contextRefs: ["example-global-contract", "example-architecture"],
				provides: ["example-stage"],
				values: {
					stage: "json-output",
					objective: "Add the JSON-only timestamp behavior.",
					default_allowed_files_array: [
						"packages/example/src/report-writer.ts",
						"packages/example/test/report-json.test.ts",
					],
					default_forbidden_files_array: [
						"packages/example/src/text-report-writer.ts",
					],
					serial_by_default_bool: true,
				},
			},
			{
				role: "child",
				logicalId: "example-t1-generated-at",
				title: "T1 JSON generatedAt field",
				description: "One red-green behavior for generatedAt.",
				needs: ["example-stage"],
				contextRefs: ["example-global-contract", "example-architecture"],
				inherits: ["example-stage"],
				typedContractRefs: ["example-artifact-contract"],
				contextUse: [
					{
						ref: "example-global-contract",
						phase: "before-edit",
						required: true,
						reason: "Scope and non-goals constrain the patch.",
						failureIfMissing: "Stop and create a decision bead.",
					},
				],
				values: {
					goal: "Make empty input write a JSON report with generatedAt.",
					expected_outcome:
						"The JSON report includes generatedAt and text output is unchanged.",
					non_goals_array: ["Do not change text output."],
					behavior_id: "T1-generatedAt",
					inputs_array: [{ type: "plan", path: "docs/plans/example-plan.md" }],
					constraints_array: [
						"Use red-green-refactor.",
						"Keep the patch JSON-only.",
					],
					allowed_files_array: [
						"packages/example/src/report-writer.ts",
						"packages/example/test/report-json.test.ts",
					],
					forbidden_files_array: ["packages/example/src/text-report-writer.ts"],
					ordered_steps_array: [
						"Run the red command.",
						"Implement the minimal JSON field.",
						"Run verification.",
					],
					green_scope:
						"Add only the JSON generatedAt field and deterministic test fixture.",
					red_command: 'pnpm test -- report-json -t "T1 generatedAt"',
					expected_failure: "JSON output has no generatedAt.",
					expected_red_shape:
						"A single assertion failure for the missing generatedAt field.",
					verification: "pnpm test -- report-json",
					acceptance_criteria_array: ["JSON output contains generatedAt."],
					output_shape: "Patch plus Beads handoff note.",
					patch_shape: "One focused code/test patch.",
					file_touches_array_of_tables: [
						{
							path: "packages/example/src/report-writer.ts",
							operation: "modify",
							reason: "Write generatedAt.",
						},
						{
							path: "packages/example/test/report-json.test.ts",
							operation: "modify",
							reason: "Prove generatedAt.",
						},
					],
					commit_boundary_table: {
						commitMessage: "test: add JSON report generatedAt",
						gitAddPaths: [
							"packages/example/src/report-writer.ts",
							"packages/example/test/report-json.test.ts",
						],
					},
					failure_conditions_array: [
						"Stop if the behavior requires text output changes.",
					],
					requires_commit_sha_bool: true,
					handoff_notes_schema_table: {
						summary: "string",
						verification: "string",
					},
				},
			},
			{
				role: "checkpoint",
				logicalId: "example-checkpoint",
				title: "Example integration checkpoint",
				description: "Verify and close the implementation stage.",
				needs: ["example-t1-generated-at"],
				contextRefs: ["example-global-contract", "example-architecture"],
				provides: ["example-checkpoint"],
				values: {
					gate_kind: "integration",
					gate_for: "example-stage",
					validation_commands_array: ["pnpm test -- report-json"],
					merge_owner: "integration-owner",
					conflict_policy: "Stop and resolve with the checkpoint owner.",
				},
			},
		],
	};
}

function printSchema() {
	console.log(JSON.stringify(minimalExampleIr(), null, 2));
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
