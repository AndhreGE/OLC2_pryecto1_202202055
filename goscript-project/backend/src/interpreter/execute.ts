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

function makeInt(value: number): RuntimeValue {
  return {
    dataType: "int",
    value: Math.trunc(value)
  };
}

function makeFloat(value: number): RuntimeValue {
  return {
    dataType: "float64",
    value
  };
}

function makeString(value: string): RuntimeValue {
  return {
    dataType: "string",
    value
  };
}

function makeBool(value: boolean): RuntimeValue {
  return {
    dataType: "bool",
    value
  };
}

function makeRune(value: string): RuntimeValue {
  return {
    dataType: "rune",
    value
  };
}

function defaultValueForType(dataType: PrimitiveType): RuntimeValue {
  switch (dataType) {
    case "int":
      return makeInt(0);
    case "float64":
      return makeFloat(0);
    case "string":
      return makeString("");
    case "bool":
      return makeBool(false);
    case "rune":
      return makeRune("\0");
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

function pushSemanticError(
  errors: CompilerError[],
  node: AstNode,
  description: string
): RuntimeValue {
  errors.push({
    type: "Semantico",
    description,
    line: node.line,
    column: node.column
  });

  return makeInt(0);
}

function runeToCode(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  return value.codePointAt(0) ?? 0;
}

function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

function formatFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
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
      return String(value.value);

    case "float64":
      return formatFloat(Number(value.value));
  }
}

function toIntLikeNumber(
  value: RuntimeValue,
  node: AstNode,
  errors: CompilerError[],
  operator: string
): number | null {
  switch (value.dataType) {
    case "int":
      return Number(value.value);

    case "bool":
      return boolToInt(Boolean(value.value));

    case "rune":
      return runeToCode(String(value.value));

    default:
      errors.push({
        type: "Semantico",
        description: `La operación "${operator}" no acepta valores de tipo ${value.dataType}.`,
        line: node.line,
        column: node.column
      });
      return null;
  }
}

function toFloatCompatibleNumber(
  value: RuntimeValue,
  node: AstNode,
  errors: CompilerError[],
  operator: string
): number | null {
  switch (value.dataType) {
    case "float64":
      return Number(value.value);

    case "int":
      return Number(value.value);

    case "bool":
      return boolToInt(Boolean(value.value));

    case "rune":
      return runeToCode(String(value.value));

    default:
      errors.push({
        type: "Semantico",
        description: `La operación "${operator}" no acepta valores de tipo ${value.dataType}.`,
        line: node.line,
        column: node.column
      });
      return null;
  }
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
    return makeFloat(Number(value.value));
  }

  errors.push({
    type: "Semantico",
    description: `No se puede asignar un valor de tipo ${value.dataType} a una variable de tipo ${expectedType}.`,
    line: node.line,
    column: node.column
  });

  return null;
}

function evaluateAddition(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  if (left.dataType === "string" || right.dataType === "string") {
    return makeString(`${formatValueForPrint(left)}${formatValueForPrint(right)}`);
  }

  if (left.dataType === "float64" || right.dataType === "float64") {
    const l = toFloatCompatibleNumber(left, node, errors, "+");
    const r = toFloatCompatibleNumber(right, node, errors, "+");

    if (l === null || r === null) {
      return makeInt(0);
    }

    return makeFloat(l + r);
  }

  if (left.dataType === "bool" && right.dataType === "bool") {
    return makeBool(Boolean(left.value) || Boolean(right.value));
  }

  const l = toIntLikeNumber(left, node, errors, "+");
  const r = toIntLikeNumber(right, node, errors, "+");

  if (l === null || r === null) {
    return makeInt(0);
  }

  return makeInt(l + r);
}

function evaluateSubtraction(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  if (left.dataType === "string" || right.dataType === "string") {
    return pushSemanticError(
      errors,
      node,
      'La operación "-" no es válida con valores string.'
    );
  }

  if (left.dataType === "float64" || right.dataType === "float64") {
    const l = toFloatCompatibleNumber(left, node, errors, "-");
    const r = toFloatCompatibleNumber(right, node, errors, "-");

    if (l === null || r === null) {
      return makeInt(0);
    }

    return makeFloat(l - r);
  }

  if (left.dataType === "bool" && right.dataType === "bool") {
    return makeInt(
      boolToInt(Boolean(left.value)) - boolToInt(Boolean(right.value))
    );
  }

  if (left.dataType === "bool" && right.dataType === "rune") {
    return makeInt(
      boolToInt(Boolean(left.value)) + runeToCode(String(right.value))
    );
  }

  const l = toIntLikeNumber(left, node, errors, "-");
  const r = toIntLikeNumber(right, node, errors, "-");

  if (l === null || r === null) {
    return makeInt(0);
  }

  return makeInt(l - r);
}

function evaluateMultiplication(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  if (left.dataType === "int" && right.dataType === "string") {
    const count = Math.trunc(Number(left.value));

    if (count < 0) {
      return pushSemanticError(
        errors,
        node,
        "No se puede repetir una cadena una cantidad negativa de veces."
      );
    }

    return makeString(String(right.value).repeat(count));
  }

  if (left.dataType === "string" || right.dataType === "string") {
    return pushSemanticError(
      errors,
      node,
      'La operación "*" solo permite repetición con int * string.'
    );
  }

  if (left.dataType === "float64" || right.dataType === "float64") {
    const l = toFloatCompatibleNumber(left, node, errors, "*");
    const r = toFloatCompatibleNumber(right, node, errors, "*");

    if (l === null || r === null) {
      return makeInt(0);
    }

    return makeFloat(l * r);
  }

  if (left.dataType === "bool" && right.dataType === "bool") {
    return makeBool(Boolean(left.value) && Boolean(right.value));
  }

  const l = toIntLikeNumber(left, node, errors, "*");
  const r = toIntLikeNumber(right, node, errors, "*");

  if (l === null || r === null) {
    return makeInt(0);
  }

  return makeInt(l * r);
}

function evaluateDivision(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  const leftAllowed = left.dataType === "int" || left.dataType === "float64";
  const rightAllowed = right.dataType === "int" || right.dataType === "float64";

  if (!leftAllowed || !rightAllowed) {
    return pushSemanticError(
      errors,
      node,
      'La operación "/" solo acepta valores int y float64.'
    );
  }

  const l = Number(left.value);
  const r = Number(right.value);

  if (r === 0) {
    return pushSemanticError(
      errors,
      node,
      "No se puede dividir entre 0."
    );
  }

  if (left.dataType === "int" && right.dataType === "int") {
    return makeInt(Math.trunc(l / r));
  }

  return makeFloat(l / r);
}

function evaluateModulo(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  if (left.dataType !== "int" || right.dataType !== "int") {
    return pushSemanticError(
      errors,
      node,
      'La operación "%" solo acepta valores int.'
    );
  }

  const l = Number(left.value);
  const r = Number(right.value);

  if (r === 0) {
    return pushSemanticError(
      errors,
      node,
      "No se puede calcular módulo entre 0."
    );
  }

  return makeInt(l % r);
}

function evaluateUnaryMinus(
  value: RuntimeValue,
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  if (value.dataType === "int") {
    return makeInt(-Number(value.value));
  }

  if (value.dataType === "float64") {
    return makeFloat(-Number(value.value));
  }

  return pushSemanticError(
    errors,
    node,
    "La negación unaria solo se aplica a int y float64."
  );
}

function evaluateEqualityComparison(
  left: RuntimeValue,
  right: RuntimeValue,
  operator: "==" | "!=",
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  let result: boolean | null = null;

  const leftNumeric = left.dataType === "int" || left.dataType === "float64";
  const rightNumeric = right.dataType === "int" || right.dataType === "float64";

  if (leftNumeric && rightNumeric) {
    result = Number(left.value) === Number(right.value);
  } else if (left.dataType === right.dataType) {
    switch (left.dataType) {
      case "bool":
        result = Boolean(left.value) === Boolean(right.value);
        break;
      case "string":
        result = String(left.value) === String(right.value);
        break;
      case "rune":
        result = String(left.value) === String(right.value);
        break;
      case "int":
      case "float64":
        result = Number(left.value) === Number(right.value);
        break;
    }
  } else {
    errors.push({
      type: "Semantico",
      description: `No se puede comparar ${left.dataType} con ${right.dataType} usando "${operator}".`,
      line: node.line,
      column: node.column
    });
    return makeInt(0);
  }

  return makeBool(operator === "==" ? result : !result);
}

function evaluateRelationalComparison(
  left: RuntimeValue,
  right: RuntimeValue,
  operator: ">" | "<" | ">=" | "<=",
  node: AstNode,
  errors: CompilerError[]
): RuntimeValue {
  let result: boolean | null = null;

  const leftNumeric = left.dataType === "int" || left.dataType === "float64";
  const rightNumeric = right.dataType === "int" || right.dataType === "float64";

  if (leftNumeric && rightNumeric) {
    const l = Number(left.value);
    const r = Number(right.value);

    switch (operator) {
      case ">":
        result = l > r;
        break;
      case "<":
        result = l < r;
        break;
      case ">=":
        result = l >= r;
        break;
      case "<=":
        result = l <= r;
        break;
    }
  } else if (left.dataType === "rune" && right.dataType === "rune") {
    const l = runeToCode(String(left.value));
    const r = runeToCode(String(right.value));

    switch (operator) {
      case ">":
        result = l > r;
        break;
      case "<":
        result = l < r;
        break;
      case ">=":
        result = l >= r;
        break;
      case "<=":
        result = l <= r;
        break;
    }
  } else {
    errors.push({
      type: "Semantico",
      description: `No se puede comparar ${left.dataType} con ${right.dataType} usando "${operator}".`,
      line: node.line,
      column: node.column
    });
    return makeInt(0);
  }

  return makeBool(Boolean(result));
}

function evaluateBinaryExpression(
  node: AstNode,
  scope: ScopeFrame,
  errors: CompilerError[]
): RuntimeValue {
  const leftNode = node.children[0];
  const rightNode = node.children[1];

  if (!leftNode || !rightNode) {
    return pushSemanticError(
      errors,
      node,
      "La expresión binaria está incompleta."
    );
  }

  const left = evaluateExpression(leftNode, scope, errors);
  const right = evaluateExpression(rightNode, scope, errors);
  const operator = node.value ?? "";

  switch (operator) {
    case "+":
      return evaluateAddition(left, right, node, errors);
    case "-":
      return evaluateSubtraction(left, right, node, errors);
    case "*":
      return evaluateMultiplication(left, right, node, errors);
    case "/":
      return evaluateDivision(left, right, node, errors);
    case "%":
      return evaluateModulo(left, right, node, errors);
    case "==":
      return evaluateEqualityComparison(left, right, "==", node, errors);
    case "!=":
      return evaluateEqualityComparison(left, right, "!=", node, errors);
    case ">":
      return evaluateRelationalComparison(left, right, ">", node, errors);
    case "<":
      return evaluateRelationalComparison(left, right, "<", node, errors);
    case ">=":
      return evaluateRelationalComparison(left, right, ">=", node, errors);
    case "<=":
      return evaluateRelationalComparison(left, right, "<=", node, errors);
    default:
      return pushSemanticError(
        errors,
        node,
        `El operador "${operator}" todavía no está soportado.`
      );
  }
}

function evaluateExpression(
  node: AstNode,
  scope: ScopeFrame,
  errors: CompilerError[]
): RuntimeValue {
  switch (node.kind) {
    case "IntLiteral":
      return makeInt(Number(node.value ?? "0"));

    case "FloatLiteral":
      return makeFloat(Number(node.value ?? "0"));

    case "StringLiteral":
      return makeString(node.value ?? "");

    case "BoolLiteral":
      return makeBool(node.value === "true");

    case "RuneLiteral":
      return makeRune(node.value ?? "\0");

    case "Identifier": {
      const resolved = resolveVariable(scope, node.value ?? "");

      if (!resolved) {
        return pushSemanticError(
          errors,
          node,
          `La variable "${node.value}" no ha sido declarada.`
        );
      }

      return cloneValue(resolved);
    }

    case "UnaryExpression": {
      const child = node.children[0];

      if (!child) {
        return pushSemanticError(
          errors,
          node,
          "La expresión unaria está incompleta."
        );
      }

      const value = evaluateExpression(child, scope, errors);

      if (node.value === "-") {
        return evaluateUnaryMinus(value, node, errors);
      }

      return pushSemanticError(
        errors,
        node,
        `El operador unario "${node.value}" todavía no está soportado.`
      );
    }

    case "BinaryExpression":
      return evaluateBinaryExpression(node, scope, errors);

    default:
      return pushSemanticError(
        errors,
        node,
        `La expresión "${node.kind}" todavía no está soportada en esta etapa.`
      );
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

      if (!idNode || !typeNode) {
        errors.push({
          type: "Semantico",
          description: "La declaración de variable está incompleta.",
          line: node.line,
          column: node.column
        });
        return;
      }

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

      if (!idNode || !exprNode) {
        errors.push({
          type: "Semantico",
          description: "La declaración corta está incompleta.",
          line: node.line,
          column: node.column
        });
        return;
      }

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

      if (!idNode || !exprNode) {
        errors.push({
          type: "Semantico",
          description: "La asignación está incompleta.",
          line: node.line,
          column: node.column
        });
        return;
      }

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
  } catch (error) {
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