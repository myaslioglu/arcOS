import ts from "typescript";

/** Where the functions codebase exports its functions from (design 1.3: esbuild bundles functions/src into functions/deploy). */
export const FUNCTIONS_ENTRY = "functions/src/index.ts";

export type ExportScan = {
  /** The value exports, by the name a deploy would see. */
  names: string[];
  /** `export * from ...` clauses: the names behind them cannot be read from this file. */
  unresolved: string[];
};

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);

function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
}

/** Reads a module's value exports without resolving anything: types are skipped, `export *` is reported apart. */
export function scanExports(source: string): ExportScan {
  const file = ts.createSourceFile("index.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const unresolved: string[] = [];
  for (const statement of file.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(statement) && exported) {
      for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name, names);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      exported
    ) {
      names.push(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? "default" : (statement.name?.text ?? "default"));
    } else if (ts.isExportAssignment(statement)) {
      names.push("default");
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (!clause) unresolved.push(statement.moduleSpecifier ? statement.moduleSpecifier.getText(file) : "*");
      else if (ts.isNamespaceExport(clause)) names.push(clause.name.text);
      else for (const element of clause.elements) if (!element.isTypeOnly) names.push(element.name.text);
    }
  }
  return { names, unresolved };
}

/**
 * The ways a firebase.json `functions` block and the entry's exports break the codebase rules; empty when they hold.
 * `scan` is null when FUNCTIONS_ENTRY does not exist. That is fine only while no functions entry is configured: with
 * one, the names a deploy would ship can't be checked, so the check fails closed.
 */
export function checkFunctions(config: { functions?: unknown }, scan: ExportScan | null): string[] {
  const problems: string[] = [];
  const raw = config.functions;
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (entries.length > 0 && scan === null) problems.push(`functions entry configured but ${FUNCTIONS_ENTRY} not found`);
  if (entries.length > 1) problems.push("firebase.json declares more than one functions entry; only the codebase arcos may exist");
  entries.forEach((entry, index) => {
    const codebase = (entry as { codebase?: unknown } | null)?.codebase;
    if (codebase !== "arcos") problems.push(`functions[${index}].codebase must be "arcos", not ${JSON.stringify(codebase)}`);
  });
  for (const name of scan?.names ?? []) {
    if (!name.startsWith("arcos")) problems.push(`the function "${name}" must have a name that starts with arcos`);
  }
  for (const from of scan?.unresolved ?? []) {
    problems.push(`the functions entry re-exports everything from ${from}; list each name so its prefix can be checked`);
  }
  return problems;
}
