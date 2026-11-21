import path from "node:path";
import ts from "typescript";

const ENTRY = path.resolve(import.meta.dirname, "../index.ts");
const FENCE = "```";

/** One export of the package, with what the type checker knows about it. */
interface Export {
  name: string;
  symbol: ts.Symbol;
  checker: ts.TypeChecker;
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const code = (text: string): string => `\`${text}\``;

/**
 * Writes a Markdown table.
 * @param head - What each column is called.
 * @param rows - Each line under the titles. A vertical bar in a cell is escaped, so it cannot end the cell.
 * @returns The lines of the table, with an empty line before them.
 */
function table(head: string[], rows: string[][]): string[] {
  const line = (cells: string[]): string =>
    `| ${cells.map((cell) => cell.replaceAll("|", String.raw`\|`)).join(" | ")} |`;
  return ["", line(head), line(head.map(() => "---")), ...rows.map(line)];
}

/**
 * Reads the exports of the package's entry point.
 * @returns Every export in the order the entry point names them, each resolved to its declaration.
 */
function readExports(): Export[] {
  const program = ts.createProgram([ENTRY], {
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(ENTRY);
  const entry = source && checker.getSymbolAtLocation(source);
  if (!entry) throw new Error(`cannot read the exports of ${ENTRY}`);
  return checker.getExportsOfModule(entry).map((alias) => ({
    name: alias.name,
    symbol: checker.getAliasedSymbol(alias),
    checker,
  }));
}

const docOf = ({ symbol, checker }: Omit<Export, "name">): string =>
  oneLine(ts.displayPartsToString(symbol.getDocumentationComment(checker)));

/**
 * Reads the doc tags of one kind.
 * @param item - The export.
 * @param tag - The tag's name, without the at sign.
 * @returns The text of each such tag, on one line.
 */
const tagsOf = (item: Export, tag: string): string[] =>
  item.symbol
    .getJsDocTags(item.checker)
    .filter((entry) => entry.name === tag)
    .map((entry) => oneLine(ts.displayPartsToString(entry.text)));

/**
 * Documents a function from its signature and its doc comment.
 * @param item - The export.
 * @param signature - How the function is called.
 * @returns The signature, the description, the parameters, what it returns, and what it throws.
 */
function functionSection(item: Export, signature: ts.Signature): string[] {
  const { name, checker } = item;
  const parameters = tagsOf(item, "param").map((text) => {
    const [parameter = "", ...words] = text.split(" - ");
    return [code(parameter), words.join(" - ")];
  });
  const returns = tagsOf(item, "returns").map((text) => `**Returns.** ${text}`);
  // A throws tag starts with the error's type in braces.
  const throws = tagsOf(item, "throws").map((text) =>
    text.replace(/^\{(\w+)\} /, "**Throws `$1`.** "),
  );
  return [
    `### ${name}()`,
    "",
    `${FENCE}ts`,
    `function ${name}${checker.signatureToString(signature)}`,
    FENCE,
    "",
    docOf(item),
    ...table(["Parameter", "Description"], parameters),
    ...[...returns, ...throws].flatMap((line) => ["", line]),
  ];
}

/**
 * Documents an interface as a table of its properties, inherited ones included.
 * @param item - The export.
 * @returns The description and one row for each property: its name, its type, and its doc comment.
 */
function interfaceSection(item: Export): string[] {
  const { name, symbol, checker } = item;
  const rows = checker
    .getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))
    .map((property) => [
      code(
        `${property.name}${property.flags & ts.SymbolFlags.Optional ? "?" : ""}`,
      ),
      code(
        checker.typeToString(
          checker.getTypeOfSymbol(property),
          undefined,
          ts.TypeFormatFlags.NoTruncation,
        ),
      ),
      docOf({ symbol: property, checker }),
    ]);
  return [
    `### ${name}`,
    "",
    docOf(item),
    ...table(["Property", "Type", "Description"], rows),
  ];
}

/**
 * Documents any other export by its declaration.
 * @param item - The export: a type alias, or a value that is not a function.
 * @returns The description and the declaration: a type alias as the source writes it, a value by its type.
 */
function declarationSection(item: Export): string[] {
  const { name, symbol, checker } = item;
  const [declaration] = symbol.getDeclarations() ?? [];
  const text =
    declaration && ts.isTypeAliasDeclaration(declaration)
      ? declaration.getText().replace(/^export /, "")
      : `const ${name}: ${checker.typeToString(checker.getTypeOfSymbol(symbol))}`;
  return [`### ${name}`, "", docOf(item), "", `${FENCE}ts`, text, FENCE];
}

/**
 * Documents one export.
 * @param item - The export.
 * @returns Whether it is a value or a type, and its section of the page.
 */
function section(item: Export): { kind: "value" | "type"; lines: string[] } {
  const { symbol, checker } = item;
  if (symbol.flags & ts.SymbolFlags.Interface) {
    return { kind: "type", lines: interfaceSection(item) };
  }
  if (symbol.flags & ts.SymbolFlags.TypeAlias) {
    return { kind: "type", lines: declarationSection(item) };
  }
  const [signature] = checker.getSignaturesOfType(
    checker.getTypeOfSymbol(symbol),
    ts.SignatureKind.Call,
  );
  return {
    kind: "value",
    lines: signature
      ? functionSection(item, signature)
      : declarationSection(item),
  };
}

/**
 * Writes the API reference from the doc comments of what the package exports.
 * @returns The body of the page: the functions and values, then the types.
 */
export function apiReference(): string {
  const sections = readExports().map(section);
  const of = (kind: "value" | "type"): string =>
    sections
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.lines.join("\n"))
      .join("\n\n");
  return `## Functions and values

${of("value")}

## Types

${of("type")}
`;
}
