#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parse } from "svelte/compiler";
import ts from "typescript";

const classifier = resolve("src/lib/effect/failure-classification.ts");
const constructors = {
	Cause: new Set([
		"empty",
		"fail",
		"die",
		"interrupt",
		"parallel",
		"sequential",
		"UnknownException",
		"RuntimeException",
		"InterruptedException",
		"IllegalArgumentException",
		"NoSuchElementException",
		"InvalidPubSubCapacityException",
		"TimeoutException",
		"ExceededCapacityException",
	]),
	FiberId: new Set(["none", "runtime", "composite", "make"]),
};
let violations = 0;

function memberName(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text;
	if (
		ts.isElementAccessExpression(node) &&
		ts.isStringLiteralLike(node.argumentExpression)
	)
		return node.argumentExpression.text;
	return undefined;
}

function inType(node) {
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (ts.isTypeNode(parent)) return true;
		if (ts.isStatement(parent) || ts.isExpression(parent)) return false;
	}
	return false;
}

function checkSource(path, code, offset = 0, original = code) {
	const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
	const namespaces = new Map();
	const effectNamespaces = new Set();
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteralLike(statement.moduleSpecifier)
		)
			continue;
		const module = statement.moduleSpecifier.text;
		const bindings = statement.importClause?.namedBindings;
		if (module === "effect" && bindings) {
			if (ts.isNamespaceImport(bindings))
				effectNamespaces.add(bindings.name.text);
			else
				for (const binding of bindings.elements) {
					const name = (binding.propertyName ?? binding.name).text;
					if (Object.hasOwn(constructors, name))
						namespaces.set(binding.name.text, name);
				}
		} else if (
			(module === "effect/Cause" || module === "effect/FiberId") &&
			bindings
		) {
			const name = module.slice("effect/".length);
			if (ts.isNamespaceImport(bindings))
				namespaces.set(bindings.name.text, name);
			else
				for (const binding of bindings.elements) {
					const member = (binding.propertyName ?? binding.name).text;
					if (
						!statement.importClause.isTypeOnly &&
						!binding.isTypeOnly &&
						!constructors[name].has(member)
					)
						report(binding, `${module}.${member}`);
				}
		}
	}
	function namespace(node) {
		if (ts.isIdentifier(node)) return namespaces.get(node.text);
		if (
			(ts.isPropertyAccessExpression(node) ||
				ts.isElementAccessExpression(node)) &&
			ts.isIdentifier(node.expression) &&
			effectNamespaces.has(node.expression.text)
		) {
			const name = memberName(node);
			if (Object.hasOwn(constructors, name)) return name;
		}
		return undefined;
	}
	function report(node, member) {
		const line = original
			.slice(0, offset + node.getStart(source))
			.split("\n").length;
		console.error(
			`${relative(process.cwd(), path)}:${line}: ${member} belongs in failure-classification.ts.`,
		);
		violations++;
	}
	function visit(node) {
		if (!inType(node)) {
			if (
				ts.isPropertyAccessExpression(node) ||
				ts.isElementAccessExpression(node)
			) {
				const member = memberName(node);
				const owner = namespace(node.expression);
				if (owner && !constructors[owner].has(member))
					report(node, `${owner}.${member ?? "[computed]"}`);
				else if (member === "interruptors") report(node, member);
			} else if (
				ts.isBindingElement(node) &&
				(ts.isIdentifier(node.propertyName ?? node.name) ||
					ts.isStringLiteralLike(node.propertyName ?? node.name)) &&
				(node.propertyName ?? node.name).text === "interruptors"
			) {
				report(node, "interruptors");
			}
			if (
				namespace(node) ||
				(ts.isIdentifier(node) && effectNamespaces.has(node.text))
			) {
				// Do not let aliases or destructuring hide subsequent inspection.
				const parent = node.parent;
				if (
					!ts.isImportSpecifier(parent) &&
					!ts.isNamespaceImport(parent) &&
					!(
						(ts.isPropertyAccessExpression(parent) ||
							ts.isElementAccessExpression(parent)) &&
						parent.expression === node
					)
				)
					report(node, namespace(node) ?? "effect namespace alias");
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

function check(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			if (!["node_modules", "generated"].includes(entry.name)) check(path);
			continue;
		}
		if (path === classifier || !/\.(?:[cm]?[jt]s|svelte)$/.test(entry.name))
			continue;
		const code = readFileSync(path, "utf8");
		if (path.endsWith(".svelte")) {
			const component = parse(code, { filename: path });
			for (const script of [component.instance, component.module])
				if (script)
					checkSource(
						path,
						code.slice(script.content.start, script.content.end),
						script.content.start,
						code,
					);
		} else checkSource(path, code);
	}
}

check(resolve("src"));
console.log(`Cause inspection boundary: ${violations} violation(s).`);
process.exitCode = violations ? 1 : 0;
