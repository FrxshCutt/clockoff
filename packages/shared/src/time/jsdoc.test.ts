/**
 * Documentation guard for the time module: every exported declaration in `src/time/*.ts` (and every property
 * of an exported interface) must carry a JSDoc comment, so consumers can code against the API from editor
 * hovers alone.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const dir = __dirname;
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

function hasJsDoc(text: string, node: ts.Node): boolean {
  const comments = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const last = comments[comments.length - 1];
  return last !== undefined && text.slice(last.pos, last.pos + 3) === "/**";
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function declarationName(node: ts.Statement): string {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((d) => d.name.getText()).join(", ");
  }
  const named = node as ts.Statement & { name?: ts.Identifier };
  return named.name?.text ?? ts.SyntaxKind[node.kind];
}

/** `file: name` for every exported declaration or exported-interface property without JSDoc. */
function undocumented(file: string): string[] {
  const text = readFileSync(join(dir, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const missing: string[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) || !isExported(statement)) continue; // `export * from` re-exports are documented at the source
    const name = declarationName(statement);
    if (!hasJsDoc(text, statement)) missing.push(`${file}: ${name}`);
    if (ts.isInterfaceDeclaration(statement)) {
      for (const member of statement.members) {
        if (!hasJsDoc(text, member)) missing.push(`${file}: ${name}.${member.name?.getText(sf) ?? "?"}`);
      }
    }
  }
  return missing;
}

describe("time module JSDoc coverage", () => {
  it("finds the module's source files", () => {
    expect(sources).toEqual(
      expect.arrayContaining(["clock.ts", "intervals.ts", "parse.ts", "recurrence.ts", "shift.ts", "time.ts", "zone.ts"]),
    );
  });

  it.each(sources)("every export in %s is documented", (file) => {
    expect(undocumented(file)).toEqual([]);
  });
});
