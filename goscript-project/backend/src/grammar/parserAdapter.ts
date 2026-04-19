import type { AstNode } from "../ast/AstNode";

type GeneratedParserLike = {
  parse: (source: string) => unknown;
  parseError?: (message: string, hash: any) => never;
  yy?: {
    shared?: {
      ast?: unknown;
    };
  };
};

type GeneratedParserModule = {
  parse?: (source: string) => unknown;
  parser?: GeneratedParserLike;
};

const generatedModule = require("./generatedParser.js") as GeneratedParserModule;
const parser: GeneratedParserLike =
  generatedModule.parser ?? (generatedModule as GeneratedParserLike);

parser.yy = parser.yy ?? {};
parser.yy.shared = parser.yy.shared ?? {};

parser.parseError = (_message: string, hash: any) => {
  const rawText =
    typeof hash?.text === "string" && hash.text.length > 0
      ? hash.text
      : hash?.token === "EOF"
        ? "fin de archivo"
        : String(hash?.token ?? "token desconocido");

  throw {
    type: "Sintactico",
    description: `Error sintáctico cerca de "${rawText}".`,
    line: hash?.loc?.first_line ?? 1,
    column: (hash?.loc?.first_column ?? 0) + 1
  };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNode(candidate: unknown): AstNode {
  if (!isObject(candidate)) {
    return {
      kind: "Unknown",
      line: 1,
      column: 1,
      children: []
    };
  }

  const rawChildren = Array.isArray(candidate.children) ? candidate.children : [];

  return {
    kind: typeof candidate.kind === "string" ? candidate.kind : "Unknown",
    value:
      candidate.value === undefined || candidate.value === null
        ? undefined
        : String(candidate.value),
    line: typeof candidate.line === "number" ? candidate.line : 1,
    column: typeof candidate.column === "number" ? candidate.column : 1,
    children: rawChildren.map(normalizeNode)
  };
}

export function parseSource(source: string): AstNode {
  try {
    parser.yy = parser.yy ?? {};
    parser.yy.shared = parser.yy.shared ?? {};
    delete parser.yy.shared.ast;

    const rawResult = parser.parse(source);

    console.error("Resultado crudo del parser:", rawResult);
    console.error("AST guardado en parser.yy.shared.ast:", parser.yy.shared.ast);

    if (parser.yy.shared.ast) {
      return normalizeNode(parser.yy.shared.ast);
    }

    if (Array.isArray(rawResult)) {
      return {
        kind: "Program",
        line: 1,
        column: 1,
        children: rawResult.map(normalizeNode)
      };
    }

    if (isObject(rawResult) && typeof rawResult.kind === "string") {
      return normalizeNode(rawResult);
    }

    throw {
      type: "Sintactico",
      description: "El parser no devolvió un AST válido.",
      line: 1,
      column: 1
    };
  } catch (error) {
    console.error("Error real del parser:", error);
    throw error;
  }
}