import type { AstNode } from "../ast/AstNode";
import { parseSource } from "../grammar/parserAdapter";
import { astToDot } from "../reports/astToDot";
import type { CompilerError, ExecutionResult, SymbolEntry } from "../shared/types";

type PrimitiveType = "int" | "float64" | "string" | "bool" | "rune";
type ReturnTypeName = PrimitiveType | "void";

interface RuntimeValue {
  dataType: PrimitiveType;
  value: number | string | boolean;
}

interface ScopeFrame {
  name: string;
  parent: ScopeFrame | null;
  values: Map<string, RuntimeValue>;
}

interface FlowSignal {
  kind: "break" | "continue" | "return";
  node: AstNode;
  value?: RuntimeValue;
}

interface ParameterInfo {
  name: string;
  dataType: PrimitiveType;
  line: number;
  column: number;
}

interface FunctionInfo {
  name: string;
  returnType: ReturnTypeName;
  params: ParameterInfo[];
  block: AstNode;
  node: AstNode;
}

interface RuntimeContext {
  functions: Map<string, FunctionInfo>;
  symbolTable: SymbolEntry[];
  consoleLines: string[];
  errors: CompilerError[];
  globalScope: ScopeFrame;
  callCounter: number;
}

type StatementResult = FlowSignal | null;

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
  context: RuntimeContext,
  node: AstNode,
  description: string
): RuntimeValue {
  context.errors.push({
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
  context: RuntimeContext,
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
      context.errors.push({
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
  context: RuntimeContext,
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
      context.errors.push({
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
  context: RuntimeContext
): RuntimeValue | null {
  if (expectedType === value.dataType) {
    return cloneValue(value);
  }

  if (expectedType === "float64" && value.dataType === "int") {
    return makeFloat(Number(value.value));
  }

  context.errors.push({
    type: "Semantico",
    description: `No se puede asignar un valor de tipo ${value.dataType} a una variable de tipo ${expectedType}.`,
    line: node.line,
    column: node.column
  });

  return null;
}

function expectBoolean(
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext,
  operator: string
): boolean | null {
  if (value.dataType !== "bool") {
    context.errors.push({
      type: "Semantico",
      description: `La operación "${operator}" solo acepta valores bool.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

  return Boolean(value.value);
}

function evaluateConditionBoolean(
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext,
  source: string
): boolean | null {
  if (value.dataType !== "bool") {
    context.errors.push({
      type: "Semantico",
      description: `La condición del ${source} debe ser bool.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

  return Boolean(value.value);
}

function areEqualValues(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): boolean | null {
  const leftNumeric = left.dataType === "int" || left.dataType === "float64";
  const rightNumeric = right.dataType === "int" || right.dataType === "float64";

  if (leftNumeric && rightNumeric) {
    return Number(left.value) === Number(right.value);
  }

  if (left.dataType === right.dataType) {
    switch (left.dataType) {
      case "bool":
        return Boolean(left.value) === Boolean(right.value);
      case "string":
        return String(left.value) === String(right.value);
      case "rune":
        return String(left.value) === String(right.value);
      case "int":
      case "float64":
        return Number(left.value) === Number(right.value);
    }
  }

  context.errors.push({
    type: "Semantico",
    description: `No se puede comparar ${left.dataType} con ${right.dataType} usando "==".`,
    line: node.line,
    column: node.column
  });
  return null;
}

function evaluateAddition(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  if (left.dataType === "string" || right.dataType === "string") {
    return makeString(`${formatValueForPrint(left)}${formatValueForPrint(right)}`);
  }

  if (left.dataType === "float64" || right.dataType === "float64") {
    const l = toFloatCompatibleNumber(left, node, context, "+");
    const r = toFloatCompatibleNumber(right, node, context, "+");

    if (l === null || r === null) {
      return makeInt(0);
    }

    return makeFloat(l + r);
  }

  if (left.dataType === "bool" && right.dataType === "bool") {
    return makeBool(Boolean(left.value) || Boolean(right.value));
  }

  const l = toIntLikeNumber(left, node, context, "+");
  const r = toIntLikeNumber(right, node, context, "+");

  if (l === null || r === null) {
    return makeInt(0);
  }

  return makeInt(l + r);
}

function evaluateSubtraction(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  if (left.dataType === "string" || right.dataType === "string") {
    return pushSemanticError(
      context,
      node,
      'La operación "-" no es válida con valores string.'
    );
  }

  if (left.dataType === "float64" || right.dataType === "float64") {
    const l = toFloatCompatibleNumber(left, node, context, "-");
    const r = toFloatCompatibleNumber(right, node, context, "-");

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

  const l = toIntLikeNumber(left, node, context, "-");
  const r = toIntLikeNumber(right, node, context, "-");

  if (l === null || r === null) {
    return makeInt(0);
  }

  return makeInt(l - r);
}

function evaluateMultiplication(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  if (left.dataType === "int" && right.dataType === "string") {
    const count = Math.trunc(Number(left.value));

    if (count < 0) {
      return pushSemanticError(
        context,
        node,
        "No se puede repetir una cadena una cantidad negativa de veces."
      );
    }

    return makeString(String(right.value).repeat(count));
  }

  if (left.dataType === "string" || right.dataType === "string") {
    return pushSemanticError(
      context,
      node,
      'La operación "*" solo permite repetición con int * string.'
    );
  }

  if (left.dataType === "float64" || right.dataType === "float64") {
    const l = toFloatCompatibleNumber(left, node, context, "*");
    const r = toFloatCompatibleNumber(right, node, context, "*");

    if (l === null || r === null) {
      return makeInt(0);
    }

    return makeFloat(l * r);
  }

  if (left.dataType === "bool" && right.dataType === "bool") {
    return makeBool(Boolean(left.value) && Boolean(right.value));
  }

  const l = toIntLikeNumber(left, node, context, "*");
  const r = toIntLikeNumber(right, node, context, "*");

  if (l === null || r === null) {
    return makeInt(0);
  }

  return makeInt(l * r);
}

function evaluateDivision(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  const leftAllowed = left.dataType === "int" || left.dataType === "float64";
  const rightAllowed = right.dataType === "int" || right.dataType === "float64";

  if (!leftAllowed || !rightAllowed) {
    return pushSemanticError(
      context,
      node,
      'La operación "/" solo acepta valores int y float64.'
    );
  }

  const l = Number(left.value);
  const r = Number(right.value);

  if (r === 0) {
    return pushSemanticError(context, node, "No se puede dividir entre 0.");
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
  context: RuntimeContext
): RuntimeValue {
  if (left.dataType !== "int" || right.dataType !== "int") {
    return pushSemanticError(
      context,
      node,
      'La operación "%" solo acepta valores int.'
    );
  }

  const l = Number(left.value);
  const r = Number(right.value);

  if (r === 0) {
    return pushSemanticError(context, node, "No se puede calcular módulo entre 0.");
  }

  return makeInt(l % r);
}

function evaluateUnaryMinus(
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  if (value.dataType === "int") {
    return makeInt(-Number(value.value));
  }

  if (value.dataType === "float64") {
    return makeFloat(-Number(value.value));
  }

  return pushSemanticError(
    context,
    node,
    "La negación unaria solo se aplica a int y float64."
  );
}

function evaluateLogicalNot(
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  const boolValue = expectBoolean(value, node, context, "!");

  if (boolValue === null) {
    return makeInt(0);
  }

  return makeBool(!boolValue);
}

function evaluateEqualityComparison(
  left: RuntimeValue,
  right: RuntimeValue,
  operator: "==" | "!=",
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  const result = areEqualValues(left, right, node, context);

  if (result === null) {
    return makeInt(0);
  }

  return makeBool(operator === "==" ? result : !result);
}

function evaluateRelationalComparison(
  left: RuntimeValue,
  right: RuntimeValue,
  operator: ">" | "<" | ">=" | "<=",
  node: AstNode,
  context: RuntimeContext
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
    context.errors.push({
      type: "Semantico",
      description: `No se puede comparar ${left.dataType} con ${right.dataType} usando "${operator}".`,
      line: node.line,
      column: node.column
    });
    return makeInt(0);
  }

  return makeBool(Boolean(result));
}

function extractFunctionInfo(
  node: AstNode,
  context: RuntimeContext
): FunctionInfo | null {
  const paramsNode = node.children[0];
  const returnTypeNode = node.children[1];
  const blockNode = node.children[2];

  if (!paramsNode || !returnTypeNode || !blockNode) {
    context.errors.push({
      type: "Semantico",
      description: `La función "${node.value ?? "desconocida"}" está incompleta en el AST.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

  const params: ParameterInfo[] = [];
  const paramNames = new Set<string>();

  for (const paramNode of paramsNode.children) {
    const idNode = paramNode.children[0];
    const typeNode = paramNode.children[1];

    if (!idNode || !typeNode) {
      context.errors.push({
        type: "Semantico",
        description: `Un parámetro de la función "${node.value ?? "desconocida"}" está incompleto.`,
        line: paramNode.line,
        column: paramNode.column
      });
      continue;
    }

    const paramName = idNode.value ?? "";
    const paramType = (typeNode.value ?? "int") as PrimitiveType;

    if (paramNames.has(paramName)) {
      context.errors.push({
        type: "Semantico",
        description: `El parámetro "${paramName}" está repetido en la función "${node.value ?? ""}".`,
        line: idNode.line,
        column: idNode.column
      });
      continue;
    }

    paramNames.add(paramName);

    params.push({
      name: paramName,
      dataType: paramType,
      line: idNode.line,
      column: idNode.column
    });
  }

  return {
    name: node.value ?? "",
    returnType: (returnTypeNode.value ?? "void") as ReturnTypeName,
    params,
    block: blockNode,
    node
  };
}

function invokeFunction(
  functionName: string,
  argValues: RuntimeValue[],
  callNode: AstNode,
  context: RuntimeContext
): RuntimeValue | null {
  const fn = context.functions.get(functionName);

  if (!fn) {
    pushSemanticError(
      context,
      callNode,
      `La función "${functionName}" no ha sido declarada.`
    );
    return makeInt(0);
  }

  if (argValues.length !== fn.params.length) {
    pushSemanticError(
      context,
      callNode,
      `La función "${functionName}" esperaba ${fn.params.length} argumento(s), pero recibió ${argValues.length}.`
    );

    if (fn.returnType === "void") {
      return null;
    }

    return defaultValueForType(fn.returnType);
  }

  context.callCounter += 1;
  const callScope = createScope(`${functionName}@call#${context.callCounter}`, context.globalScope);

  for (let i = 0; i < fn.params.length; i++) {
    const param = fn.params[i];
    const argValue = argValues[i];
    const coerced = coerceValue(param.dataType, argValue, callNode, context);

    if (!coerced) {
      if (fn.returnType === "void") {
        return null;
      }
      return defaultValueForType(fn.returnType);
    }

    callScope.values.set(param.name, coerced);

    registerSymbol(
      context.symbolTable,
      param.name,
      "Parámetro",
      param.dataType,
      callScope.name,
      param.line,
      param.column
    );
  }

  const signal = executeBlock(fn.block, callScope, context);

  if (signal?.kind === "break") {
    context.errors.push({
      type: "Semantico",
      description: 'La sentencia break solo se puede usar dentro de un for o switch.',
      line: signal.node.line,
      column: signal.node.column
    });

    if (fn.returnType === "void") {
      return null;
    }

    return defaultValueForType(fn.returnType);
  }

  if (signal?.kind === "continue") {
    context.errors.push({
      type: "Semantico",
      description: 'La sentencia continue solo se puede usar dentro de un for.',
      line: signal.node.line,
      column: signal.node.column
    });

    if (fn.returnType === "void") {
      return null;
    }

    return defaultValueForType(fn.returnType);
  }

  if (fn.returnType === "void") {
    if (signal?.kind === "return" && signal.value !== undefined) {
      context.errors.push({
        type: "Semantico",
        description: `La función "${functionName}" no debe retornar un valor.`,
        line: signal.node.line,
        column: signal.node.column
      });
    }

    return null;
  }

  if (!signal || signal.kind !== "return") {
    context.errors.push({
      type: "Semantico",
      description: `La función "${functionName}" debe retornar un valor de tipo ${fn.returnType}.`,
      line: fn.node.line,
      column: fn.node.column
    });

    return defaultValueForType(fn.returnType);
  }

  if (signal.value === undefined) {
    context.errors.push({
      type: "Semantico",
      description: `La función "${functionName}" debe retornar un valor de tipo ${fn.returnType}.`,
      line: signal.node.line,
      column: signal.node.column
    });

    return defaultValueForType(fn.returnType);
  }

  const coercedReturn = coerceValue(fn.returnType, signal.value, signal.node, context);

  if (!coercedReturn) {
    return defaultValueForType(fn.returnType);
  }

  return coercedReturn;
}

function evaluateCallExpression(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const functionName = node.value ?? "";
  const argValues = node.children.map((child) => evaluateExpression(child, scope, context));
  const result = invokeFunction(functionName, argValues, node, context);

  if (result === null) {
    return pushSemanticError(
      context,
      node,
      `La función "${functionName}" no retorna un valor utilizable en expresiones.`
    );
  }

  return result;
}

function evaluateBinaryExpression(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const leftNode = node.children[0];
  const rightNode = node.children[1];

  if (!leftNode || !rightNode) {
    return pushSemanticError(context, node, "La expresión binaria está incompleta.");
  }

  const operator = node.value ?? "";

  if (operator === "&&") {
    const left = evaluateExpression(leftNode, scope, context);
    const leftBool = expectBoolean(left, node, context, "&&");

    if (leftBool === null) {
      return makeInt(0);
    }

    if (!leftBool) {
      return makeBool(false);
    }

    const right = evaluateExpression(rightNode, scope, context);
    const rightBool = expectBoolean(right, node, context, "&&");

    if (rightBool === null) {
      return makeInt(0);
    }

    return makeBool(rightBool);
  }

  if (operator === "||") {
    const left = evaluateExpression(leftNode, scope, context);
    const leftBool = expectBoolean(left, node, context, "||");

    if (leftBool === null) {
      return makeInt(0);
    }

    if (leftBool) {
      return makeBool(true);
    }

    const right = evaluateExpression(rightNode, scope, context);
    const rightBool = expectBoolean(right, node, context, "||");

    if (rightBool === null) {
      return makeInt(0);
    }

    return makeBool(rightBool);
  }

  const left = evaluateExpression(leftNode, scope, context);
  const right = evaluateExpression(rightNode, scope, context);

  switch (operator) {
    case "+":
      return evaluateAddition(left, right, node, context);
    case "-":
      return evaluateSubtraction(left, right, node, context);
    case "*":
      return evaluateMultiplication(left, right, node, context);
    case "/":
      return evaluateDivision(left, right, node, context);
    case "%":
      return evaluateModulo(left, right, node, context);
    case "==":
      return evaluateEqualityComparison(left, right, "==", node, context);
    case "!=":
      return evaluateEqualityComparison(left, right, "!=", node, context);
    case ">":
      return evaluateRelationalComparison(left, right, ">", node, context);
    case "<":
      return evaluateRelationalComparison(left, right, "<", node, context);
    case ">=":
      return evaluateRelationalComparison(left, right, ">=", node, context);
    case "<=":
      return evaluateRelationalComparison(left, right, "<=", node, context);
    default:
      return pushSemanticError(
        context,
        node,
        `El operador "${operator}" todavía no está soportado.`
      );
  }
}

function evaluateExpression(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
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
          context,
          node,
          `La variable "${node.value}" no ha sido declarada.`
        );
      }

      return cloneValue(resolved);
    }

    case "CallExpression":
      return evaluateCallExpression(node, scope, context);

    case "UnaryExpression": {
      const child = node.children[0];

      if (!child) {
        return pushSemanticError(context, node, "La expresión unaria está incompleta.");
      }

      const value = evaluateExpression(child, scope, context);

      if (node.value === "-") {
        return evaluateUnaryMinus(value, node, context);
      }

      if (node.value === "!") {
        return evaluateLogicalNot(value, node, context);
      }

      return pushSemanticError(
        context,
        node,
        `El operador unario "${node.value}" todavía no está soportado.`
      );
    }

    case "BinaryExpression":
      return evaluateBinaryExpression(node, scope, context);

    default:
      return pushSemanticError(
        context,
        node,
        `La expresión "${node.kind}" todavía no está soportada en esta etapa.`
      );
  }
}

function executeNestedBlock(
  blockNode: AstNode,
  parentScope: ScopeFrame,
  context: RuntimeContext,
  scopeName: string
): StatementResult {
  const nestedScope = createScope(scopeName, parentScope);
  return executeBlock(blockNode, nestedScope, context);
}

function executeIfStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  const conditionNode = node.children[0];
  const thenBlock = node.children[1];
  const elseBranch = node.children[2];

  if (!conditionNode || !thenBlock) {
    context.errors.push({
      type: "Semantico",
      description: "La sentencia if está incompleta.",
      line: node.line,
      column: node.column
    });
    return null;
  }

  const conditionValue = evaluateExpression(conditionNode, scope, context);
  const conditionBool = evaluateConditionBoolean(
    conditionValue,
    conditionNode,
    context,
    "if"
  );

  if (conditionBool === null) {
    return null;
  }

  if (conditionBool) {
    return executeNestedBlock(
      thenBlock,
      scope,
      context,
      `if@${node.line}:${node.column}`
    );
  }

  if (!elseBranch) {
    return null;
  }

  const elseNode = elseBranch.children[0];

  if (!elseNode) {
    return null;
  }

  if (elseNode.kind === "Block") {
    return executeNestedBlock(
      elseNode,
      scope,
      context,
      `else@${elseNode.line}:${elseNode.column}`
    );
  }

  if (elseNode.kind === "IfStatement") {
    return executeIfStatement(elseNode, scope, context);
  }

  context.errors.push({
    type: "Semantico",
    description: "La rama else del if no es válida.",
    line: elseNode.line,
    column: elseNode.column
  });

  return null;
}

function executeIncDecStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext,
  delta: number
): void {
  const idNode = node.children[0];

  if (!idNode) {
    context.errors.push({
      type: "Semantico",
      description: "La operación de incremento/decremento está incompleta.",
      line: node.line,
      column: node.column
    });
    return;
  }

  const varName = idNode.value ?? "";
  const frame = findVariableFrame(scope, varName);

  if (!frame) {
    context.errors.push({
      type: "Semantico",
      description: `La variable "${varName}" no ha sido declarada.`,
      line: idNode.line,
      column: idNode.column
    });
    return;
  }

  const currentValue = frame.values.get(varName);

  if (!currentValue) {
    context.errors.push({
      type: "Semantico",
      description: `La variable "${varName}" no pudo resolverse correctamente.`,
      line: idNode.line,
      column: idNode.column
    });
    return;
  }

  if (currentValue.dataType === "int") {
    frame.values.set(varName, makeInt(Number(currentValue.value) + delta));
    return;
  }

  if (currentValue.dataType === "float64") {
    frame.values.set(varName, makeFloat(Number(currentValue.value) + delta));
    return;
  }

  context.errors.push({
    type: "Semantico",
    description: `La operación ${delta > 0 ? "++" : "--"} solo se permite sobre variables int o float64.`,
    line: idNode.line,
    column: idNode.column
  });
}

function executeReturnStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  const exprNode = node.children[0];

  if (!exprNode) {
    return { kind: "return", node };
  }

  const value = evaluateExpression(exprNode, scope, context);
  return { kind: "return", node, value };
}

function executeSwitchStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  const switchExprNode = node.children[0];

  if (!switchExprNode) {
    context.errors.push({
      type: "Semantico",
      description: "La sentencia switch está incompleta.",
      line: node.line,
      column: node.column
    });
    return null;
  }

  const switchValue = evaluateExpression(switchExprNode, scope, context);
  let defaultClause: AstNode | null = null;

  for (let i = 1; i < node.children.length; i++) {
    const clause = node.children[i];

    if (clause.kind === "DefaultClause") {
      defaultClause = clause;
      continue;
    }

    if (clause.kind !== "CaseClause") {
      context.errors.push({
        type: "Semantico",
        description: "Se encontró una cláusula inválida dentro del switch.",
        line: clause.line,
        column: clause.column
      });
      continue;
    }

    const caseValuesNode = clause.children[0];
    const caseBlock = clause.children[1];

    if (!caseValuesNode || !caseBlock) {
      context.errors.push({
        type: "Semantico",
        description: "Una cláusula case del switch está incompleta.",
        line: clause.line,
        column: clause.column
      });
      return null;
    }

    let matched = false;

    for (const caseExpr of caseValuesNode.children) {
      const caseValue = evaluateExpression(caseExpr, scope, context);
      const equalResult = areEqualValues(switchValue, caseValue, caseExpr, context);

      if (equalResult === null) {
        return null;
      }

      if (equalResult) {
        matched = true;
        break;
      }
    }

    if (!matched) {
      continue;
    }

    const signal = executeNestedBlock(
      caseBlock,
      scope,
      context,
      `switch-case@${clause.line}:${clause.column}`
    );

    if (signal?.kind === "break") {
      return null;
    }

    return signal;
  }

  if (defaultClause) {
    const defaultBlock = defaultClause.children[0];

    if (!defaultBlock) {
      context.errors.push({
        type: "Semantico",
        description: "La cláusula default del switch está incompleta.",
        line: defaultClause.line,
        column: defaultClause.column
      });
      return null;
    }

    const signal = executeNestedBlock(
      defaultBlock,
      scope,
      context,
      `switch-default@${defaultClause.line}:${defaultClause.column}`
    );

    if (signal?.kind === "break") {
      return null;
    }

    return signal;
  }

  return null;
}

function executeForStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  const loopScope = createScope(`for@${node.line}:${node.column}`, scope);
  const maxIterations = 10000;
  let iterations = 0;

  if (node.value === "condition") {
    const conditionNode = node.children[0];
    const blockNode = node.children[1];

    if (!conditionNode || !blockNode) {
      context.errors.push({
        type: "Semantico",
        description: "La sentencia for por condición está incompleta.",
        line: node.line,
        column: node.column
      });
      return null;
    }

    while (true) {
      if (iterations >= maxIterations) {
        context.errors.push({
          type: "Semantico",
          description: "El for superó el límite máximo de iteraciones permitido.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      const conditionValue = evaluateExpression(conditionNode, loopScope, context);
      const conditionBool = evaluateConditionBoolean(
        conditionValue,
        conditionNode,
        context,
        "for"
      );

      if (conditionBool === null) {
        return null;
      }

      if (!conditionBool) {
        return null;
      }

      iterations++;

      const bodySignal = executeNestedBlock(
        blockNode,
        loopScope,
        context,
        `for-body@${node.line}:${node.column}#${iterations}`
      );

      if (bodySignal?.kind === "break") {
        return null;
      }

      if (bodySignal?.kind === "continue") {
        continue;
      }

      if (bodySignal?.kind === "return") {
        return bodySignal;
      }
    }
  }

  if (node.value === "classic") {
    const initNode = node.children[0];
    const conditionNode = node.children[1];
    const updateNode = node.children[2];
    const blockNode = node.children[3];

    if (!blockNode) {
      context.errors.push({
        type: "Semantico",
        description: "La sentencia for clásica está incompleta.",
        line: node.line,
        column: node.column
      });
      return null;
    }

    if (initNode && initNode.kind !== "Empty") {
      const initSignal = executeStatement(initNode, loopScope, context);
      if (initSignal) {
        return initSignal;
      }
    }

    while (true) {
      if (iterations >= maxIterations) {
        context.errors.push({
          type: "Semantico",
          description: "El for superó el límite máximo de iteraciones permitido.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      if (conditionNode && conditionNode.kind !== "Empty") {
        const conditionValue = evaluateExpression(conditionNode, loopScope, context);
        const conditionBool = evaluateConditionBoolean(
          conditionValue,
          conditionNode,
          context,
          "for"
        );

        if (conditionBool === null) {
          return null;
        }

        if (!conditionBool) {
          return null;
        }
      }

      iterations++;

      const bodySignal = executeNestedBlock(
        blockNode,
        loopScope,
        context,
        `for-body@${node.line}:${node.column}#${iterations}`
      );

      if (bodySignal?.kind === "break") {
        return null;
      }

      if (bodySignal?.kind === "return") {
        return bodySignal;
      }

      if (updateNode && updateNode.kind !== "Empty") {
        const updateSignal = executeStatement(updateNode, loopScope, context);
        if (
          updateSignal?.kind === "break" ||
          updateSignal?.kind === "continue" ||
          updateSignal?.kind === "return"
        ) {
          return updateSignal;
        }
      }

      if (bodySignal?.kind === "continue") {
        continue;
      }
    }
  }

  context.errors.push({
    type: "Semantico",
    description: "Tipo de sentencia for no soportado.",
    line: node.line,
    column: node.column
  });

  return null;
}

function executeStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  switch (node.kind) {
    case "PrintlnStatement": {
      const parts = node.children.map((child) => {
        const value = evaluateExpression(child, scope, context);
        return formatValueForPrint(value);
      });

      context.consoleLines.push(parts.join(" "));
      return null;
    }

    case "ExpressionStatement": {
      const exprNode = node.children[0];
      if (exprNode?.kind === "CallExpression") {
        const functionName = exprNode.value ?? "";
        const argValues = exprNode.children.map((child) =>
          evaluateExpression(child, scope, context)
        );
        invokeFunction(functionName, argValues, exprNode, context);
      }
      return null;
    }

    case "IfStatement":
      return executeIfStatement(node, scope, context);

    case "ForStatement":
      return executeForStatement(node, scope, context);

    case "SwitchStatement":
      return executeSwitchStatement(node, scope, context);

    case "IncStatement":
      executeIncDecStatement(node, scope, context, 1);
      return null;

    case "DecStatement":
      executeIncDecStatement(node, scope, context, -1);
      return null;

    case "BreakStatement":
      return { kind: "break", node };

    case "ContinueStatement":
      return { kind: "continue", node };

    case "ReturnStatement":
      return executeReturnStatement(node, scope, context);

    case "VarDeclaration": {
      const idNode = node.children[0];
      const typeNode = node.children[1];
      const exprNode = node.children[2];

      if (!idNode || !typeNode) {
        context.errors.push({
          type: "Semantico",
          description: "La declaración de variable está incompleta.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      const varName = idNode.value ?? "";
      const declaredType = (typeNode.value ?? "int") as PrimitiveType;

      if (scope.values.has(varName)) {
        context.errors.push({
          type: "Semantico",
          description: `La variable "${varName}" ya existe en el ámbito actual.`,
          line: idNode.line,
          column: idNode.column
        });
        return null;
      }

      let finalValue: RuntimeValue | null;

      if (exprNode) {
        const exprValue = evaluateExpression(exprNode, scope, context);
        finalValue = coerceValue(declaredType, exprValue, exprNode, context);
      } else {
        finalValue = defaultValueForType(declaredType);
      }

      if (!finalValue) {
        return null;
      }

      scope.values.set(varName, finalValue);

      registerSymbol(
        context.symbolTable,
        varName,
        "Variable",
        declaredType,
        scope.name,
        idNode.line,
        idNode.column
      );

      return null;
    }

    case "ShortDeclaration": {
      const idNode = node.children[0];
      const exprNode = node.children[1];

      if (!idNode || !exprNode) {
        context.errors.push({
          type: "Semantico",
          description: "La declaración corta está incompleta.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      const varName = idNode.value ?? "";

      if (scope.values.has(varName)) {
        context.errors.push({
          type: "Semantico",
          description: `La variable "${varName}" ya existe en el ámbito actual.`,
          line: idNode.line,
          column: idNode.column
        });
        return null;
      }

      const exprValue = evaluateExpression(exprNode, scope, context);

      scope.values.set(varName, exprValue);

      registerSymbol(
        context.symbolTable,
        varName,
        "Variable",
        exprValue.dataType,
        scope.name,
        idNode.line,
        idNode.column
      );

      return null;
    }

    case "Assignment": {
      const idNode = node.children[0];
      const exprNode = node.children[1];

      if (!idNode || !exprNode) {
        context.errors.push({
          type: "Semantico",
          description: "La asignación está incompleta.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      const varName = idNode.value ?? "";
      const frame = findVariableFrame(scope, varName);

      if (!frame) {
        context.errors.push({
          type: "Semantico",
          description: `La variable "${varName}" no ha sido declarada.`,
          line: idNode.line,
          column: idNode.column
        });
        return null;
      }

      const currentValue = frame.values.get(varName);

      if (!currentValue) {
        context.errors.push({
          type: "Semantico",
          description: `La variable "${varName}" no pudo resolverse correctamente.`,
          line: idNode.line,
          column: idNode.column
        });
        return null;
      }

      const exprValue = evaluateExpression(exprNode, scope, context);
      const finalValue = coerceValue(currentValue.dataType, exprValue, exprNode, context);

      if (!finalValue) {
        return null;
      }

      frame.values.set(varName, finalValue);
      return null;
    }

    default:
      context.errors.push({
        type: "Semantico",
        description: `La instrucción "${node.kind}" todavía no está soportada en esta etapa.`,
        line: node.line,
        column: node.column
      });
      return null;
  }
}

function executeBlock(
  blockNode: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  for (const statement of blockNode.children) {
    const signal = executeStatement(statement, scope, context);
    if (signal) {
      return signal;
    }
  }

  return null;
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

  const globalScope = createScope("Global", null);

  const context: RuntimeContext = {
    functions: new Map<string, FunctionInfo>(),
    symbolTable: [],
    consoleLines: [],
    errors: [],
    globalScope,
    callCounter: 0
  };

  const astChildren = Array.isArray(ast.children) ? ast.children : [];

  for (const child of astChildren) {
    if (child.kind !== "FunctionDeclaration") {
      continue;
    }

    const fnInfo = extractFunctionInfo(child, context);

    if (!fnInfo) {
      continue;
    }

    if (context.functions.has(fnInfo.name)) {
      context.errors.push({
        type: "Semantico",
        description: `La función "${fnInfo.name}" ya fue declarada.`,
        line: child.line,
        column: child.column
      });
      continue;
    }

    context.functions.set(fnInfo.name, fnInfo);

    registerSymbol(
      context.symbolTable,
      fnInfo.name,
      "Función",
      fnInfo.returnType,
      "Global",
      child.line,
      child.column
    );
  }

  const mainFn = context.functions.get("main");

  if (!mainFn) {
    context.errors.push({
      type: "Semantico",
      description: 'No se encontró la función principal "main".',
      line: 1,
      column: 1
    });

    return {
      console: "",
      errors: context.errors,
      symbolTable: context.symbolTable,
      ast,
      astDot: astToDot(ast)
    };
  }

  if (mainFn.params.length > 0) {
    context.errors.push({
      type: "Semantico",
      description: 'La función "main" no debe recibir parámetros.',
      line: mainFn.node.line,
      column: mainFn.node.column
    });
  }

  if (mainFn.returnType !== "void") {
    context.errors.push({
      type: "Semantico",
      description: 'La función "main" debe ser de tipo void en esta etapa.',
      line: mainFn.node.line,
      column: mainFn.node.column
    });
  }

  const mainResult = invokeFunction("main", [], mainFn.node, context);

  void mainResult;

  return {
    console: context.consoleLines.join("\n"),
    errors: context.errors,
    symbolTable: context.symbolTable,
    ast,
    astDot: astToDot(ast)
  };
}