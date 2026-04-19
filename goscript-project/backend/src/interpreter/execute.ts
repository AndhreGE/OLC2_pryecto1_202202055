import type { AstNode } from "../ast/AstNode";
import { parseSource } from "../grammar/parserAdapter";
import { astToDot } from "../reports/astToDot";
import type { CompilerError, ExecutionResult, SymbolEntry } from "../shared/types";

type PrimitiveType = "int" | "float64" | "string" | "bool" | "rune";

interface RuntimeValue {
  dataType: PrimitiveType;
  value: number | string | boolean;
}

interface ScopeFrame {
  name: string;
  parent: ScopeFrame | null;
  values: Map<string, RuntimeValue>;
}

function createScope(name: string, parent: ScopeFrame | null): ScopeFrame {
  return {
    name,
    parent,
    values: new Map<string, RuntimeValue>()
  };
}

function registerSymbol(
  symbolTable: SymbolEntry[],
  id: string,
  symbolType: string,
  dataType: string,
  scope: string,
  line: number,
  column: number
): void {
  symbolTable.push({
    id,
    symbolType,
    dataType,
    scope,
    line,
    column
  });
}

function cloneValue(value: RuntimeValue): RuntimeValue {
  return {
    dataType: value.dataType,
    value: value.value
  };
}

function defaultValueForType(dataType: PrimitiveType): RuntimeValue {
  switch (dataType) {
    case "int":
      return { dataType: "int", value: 0 };
    case "float64":
      return { dataType: "float64", value: 0 };
    case "string":
      return { dataType: "string", value: "" };
    case "bool":
      return { dataType: "bool", value: false };
    case "rune":
      return { dataType: "rune", value: "\0" };
  }
}

function findVariableFrame(scope: ScopeFrame, name: string): ScopeFrame | null {
  let current: ScopeFrame | null = scope;

  while (current) {
    if (current.values.has(name)) {
      return current;
    }

    current = current.parent;
  }

  return null;
}

function resolveVariable(scope: ScopeFrame, name: string): RuntimeValue | null {
  const frame = findVariableFrame(scope, name);

  if (!frame) {
    return null;
  }

  return frame.values.get(name) ?? null;
}

function coerceValue(
  expectedType: PrimitiveType,
  value: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue | null {
  if (expectedType === value.dataType) {
    return cloneValue(value);
  }

  if (expectedType === "float64" && value.dataType === "int") {
    return {
      dataType: "float64",
      value: Number(value.value)
    };
  }

  errors.push({
    type: "Semantico",
    description: `No se puede asignar un valor de tipo ${value.dataType} a una variable de tipo ${expectedType}.`,
    line: node.line,
    column: node.column
  });

  return null;
}

function evaluateExpression(
  node: AstNode,
  scope: ScopeFrame,
  errors: CompilerError[]
): RuntimeValue {
  switch (node.kind) {
    case "IntLiteral":
      return {
        dataType: "int",
        value: Number(node.value ?? "0")
      };

    case "FloatLiteral":
      return {
        dataType: "float64",
        value: Number(node.value ?? "0")
      };

    case "StringLiteral":
      return {
        dataType: "string",
        value: node.value ?? ""
      };

    case "BoolLiteral":
      return {
        dataType: "bool",
        value: node.value === "true"
      };

    case "RuneLiteral":
      return {
        dataType: "rune",
        value: node.value ?? "\0"
      };

    case "Identifier": {
      const resolved = resolveVariable(scope, node.value ?? "");

      if (!resolved) {
        errors.push({
          type: "Semantico",
          description: `La variable "${node.value}" no ha sido declarada.`,
          line: node.line,
          column: node.column
        });

        return {
          dataType: "int",
          value: 0
        };
      }

      return cloneValue(resolved);
    }

    default:
      errors.push({
        type: "Semantico",
        description: `La expresión "${node.kind}" todavía no está soportada en esta etapa.`,
        line: node.line,
        column: node.column
      });

      return {
        dataType: "int",
        value: 0
      };
  }
}

function formatValueForPrint(value: RuntimeValue): string {
  switch (value.dataType) {
    case "bool":
      return value.value ? "true" : "false";

    case "rune":
      return String(value.value);

    case "string":
      return String(value.value);

    case "int":
    case "float64":
      return String(value.value);
  }
}

function executeStatement(
  node: AstNode,
  scope: ScopeFrame,
  symbolTable: SymbolEntry[],
  consoleLines: string[],
  errors: CompilerError[]
): void {
  switch (node.kind) {
    case "PrintlnStatement": {
      const parts = node.children.map((child) => {
        const value = evaluateExpression(child, scope, errors);
        return formatValueForPrint(value);
      });

      consoleLines.push(parts.join(" "));
      return;
    }

    case "VarDeclaration": {
      const idNode = node.children[0];
      const typeNode = node.children[1];
      const exprNode = node.children[2];

      const varName = idNode.value ?? "";
      const declaredType = (typeNode.value ?? "int") as PrimitiveType;

      if (scope.values.has(varName)) {
        errors.push({
          type: "Semantico",
          description: `La variable "${varName}" ya existe en el ámbito actual.`,
          line: idNode.line,
          column: idNode.column
        });
        return;
      }

      let finalValue: RuntimeValue | null;

      if (exprNode) {
        const exprValue = evaluateExpression(exprNode, scope, errors);
        finalValue = coerceValue(declaredType, exprValue, exprNode, errors);
      } else {
        finalValue = defaultValueForType(declaredType);
      }

      if (!finalValue) {
        return;
      }

      scope.values.set(varName, finalValue);

      registerSymbol(
        symbolTable,
        varName,
        "Variable",
        declaredType,
        scope.name,
        idNode.line,
        idNode.column
      );

      return;
    }

    case "ShortDeclaration": {
      const idNode = node.children[0];
      const exprNode = node.children[1];

      const varName = idNode.value ?? "";

      if (scope.values.has(varName)) {
        errors.push({
          type: "Semantico",
          description: `La variable "${varName}" ya existe en el ámbito actual.`,
          line: idNode.line,
          column: idNode.column
        });
        return;
      }

      const exprValue = evaluateExpression(exprNode, scope, errors);

      scope.values.set(varName, exprValue);

      registerSymbol(
        symbolTable,
        varName,
        "Variable",
        exprValue.dataType,
        scope.name,
        idNode.line,
        idNode.column
      );

      return;
    }

    case "Assignment": {
      const idNode = node.children[0];
      const exprNode = node.children[1];
      const varName = idNode.value ?? "";

      const frame = findVariableFrame(scope, varName);

      if (!frame) {
        errors.push({
          type: "Semantico",
          description: `La variable "${varName}" no ha sido declarada.`,
          line: idNode.line,
          column: idNode.column
        });
        return;
      }

      const currentValue = frame.values.get(varName);

      if (!currentValue) {
        errors.push({
          type: "Semantico",
          description: `La variable "${varName}" no pudo resolverse correctamente.`,
          line: idNode.line,
          column: idNode.column
        });
        return;
      }

      const exprValue = evaluateExpression(exprNode, scope, errors);
      const finalValue = coerceValue(currentValue.dataType, exprValue, exprNode, errors);

      if (!finalValue) {
        return;
      }

      frame.values.set(varName, finalValue);
      return;
    }

    default:
      errors.push({
        type: "Semantico",
        description: `La instrucción "${node.kind}" todavía no está soportada en esta etapa.`,
        line: node.line,
        column: node.column
      });
  }
}

function executeBlock(
  blockNode: AstNode,
  scope: ScopeFrame,
  symbolTable: SymbolEntry[],
  consoleLines: string[],
  errors: CompilerError[]
): void {
  for (const statement of blockNode.children) {
    executeStatement(statement, scope, symbolTable, consoleLines, errors);
  }
}

export function executeSource(source: string): ExecutionResult {
  const normalized = source.replace(/\r\n/g, "\n");

  if (normalized.trim().length === 0) {
    return {
      console: "",
      errors: [
        {
          type: "Semantico",
          description: "No se recibió código fuente para ejecutar.",
          line: 1,
          column: 1
        }
      ],
      symbolTable: [],
      ast: null,
      astDot: ""
    };
  }

  let ast: AstNode;

  try {
    ast = parseSource(normalized);
  }  catch (error) {
    console.error("Error atrapado en executeSource:", error);

    const compilerError =
      error &&
      typeof error === "object" &&
      "type" in error &&
      "description" in error &&
      "line" in error &&
      "column" in error
        ? (error as CompilerError)
        : error instanceof Error
          ? {
              type: "Sintactico" as const,
              description: error.message,
              line: 1,
              column: 1
            }
          : {
              type: "Sintactico" as const,
              description: "Ocurrió un error inesperado durante el análisis.",
              line: 1,
              column: 1
            };

    return {
      console: "",
      errors: [compilerError],
      symbolTable: [],
      ast: null,
      astDot: ""
    };
  }

  const errors: CompilerError[] = [];
  const symbolTable: SymbolEntry[] = [];
  const consoleLines: string[] = [];

  const astChildren = Array.isArray(ast.children) ? ast.children : [];

    const functionNodes = astChildren.filter(
        (child) => child.kind === "FunctionDeclaration"
    );

  const functionNames = new Set<string>();
  let mainFunction: AstNode | null = null;

  for (const fn of functionNodes) {
    const fnName = fn.value ?? "";

    if (functionNames.has(fnName)) {
      errors.push({
        type: "Semantico",
        description: `La función "${fnName}" ya fue declarada.`,
        line: fn.line,
        column: fn.column
      });
      continue;
    }

    functionNames.add(fnName);

    registerSymbol(
      symbolTable,
      fnName,
      "Función",
      "void",
      "Global",
      fn.line,
      fn.column
    );

    if (fnName === "main") {
      mainFunction = fn;
    }
  }

  if (!mainFunction) {
    errors.push({
      type: "Semantico",
      description: 'No se encontró la función principal "main".',
      line: 1,
      column: 1
    });

    return {
      console: "",
      errors,
      symbolTable,
      ast,
      astDot: astToDot(ast)
    };
  }

  const globalScope = createScope("Global", null);
  const mainScope = createScope("main", globalScope);
  const mainBlock = mainFunction.children[0];

  if (mainBlock) {
    executeBlock(mainBlock, mainScope, symbolTable, consoleLines, errors);
  }

  return {
    console: consoleLines.join("\n"),
    errors,
    symbolTable,
    ast,
    astDot: astToDot(ast)
  };
}
