import type { AstNode } from "../ast/AstNode";
import { parseSource } from "../grammar/parserAdapter";
import { astToDot } from "../reports/astToDot";
import type { CompilerError, ExecutionResult, SymbolEntry } from "../shared/types";

type PrimitiveType = "int" | "float64" | "string" | "bool" | "rune";
type RuntimeType = PrimitiveType | "array" | "slice" | "struct";
type NonVoidTypeName = string;
type ReturnTypeName = NonVoidTypeName | "void";

interface RuntimeValue {
  dataType: RuntimeType;
  value: number | string | boolean | RuntimeValue[] | Record<string, RuntimeValue>;
  elementType?: NonVoidTypeName;
  size?: number;
  structName?: string;
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
  typeName: NonVoidTypeName;
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

interface StructFieldInfo {
  name: string;
  typeName: NonVoidTypeName;
  line: number;
  column: number;
}

interface StructInfo {
  name: string;
  fields: StructFieldInfo[];
  fieldMap: Map<string, StructFieldInfo>;
  node: AstNode;
}

interface RuntimeContext {
  functions: Map<string, FunctionInfo>;
  structs: Map<string, StructInfo>;
  symbolTable: SymbolEntry[];
  consoleLines: string[];
  errors: CompilerError[];
  globalScope: ScopeFrame;
  callCounter: number;
}

interface AssignableReference {
  currentValue: RuntimeValue;
  setValue: (nextValue: RuntimeValue) => void;
}

type StatementResult = FlowSignal | null;

/*
  ============================================================
  PARSEO DE TIPOS TEXTUALES
  ============================================================
*/

function isPrimitiveTypeName(typeName: string): typeName is PrimitiveType {
  return (
    typeName === "int" ||
    typeName === "float64" ||
    typeName === "string" ||
    typeName === "bool" ||
    typeName === "rune"
  );
}

function parseSliceTypeText(typeName: string): { elementType: string } | null {
  if (!typeName.startsWith("[]")) {
    return null;
  }

  return {
    elementType: typeName.slice(2)
  };
}

function parseArrayTypeText(typeName: string): { size: number; elementType: string } | null {
  const match = typeName.match(/^\[(\d+)\](.+)$/);

  if (!match) {
    return null;
  }

  return {
    size: Number(match[1]),
    elementType: match[2]
  };
}

function typeStringFromTypeNode(typeNode: AstNode | undefined): string {
  if (!typeNode) {
    return "int";
  }

  if (typeNode.kind === "ArrayType") {
    return `[${typeNode.value ?? "0"}]${typeStringFromTypeNode(typeNode.children[0])}`;
  }

  if (typeNode.kind === "SliceType") {
    return `[]${typeStringFromTypeNode(typeNode.children[0])}`;
  }

  return typeNode.value ?? "int";
}

/*
  ============================================================
  SCOPES Y TABLA DE SÍMBOLOS
  ============================================================
*/

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

/*
  ============================================================
  RUNTIME VALUES
  ============================================================
*/

function isArrayValue(value: RuntimeValue): boolean {
  return value.dataType === "array";
}

function isSliceValue(value: RuntimeValue): boolean {
  return value.dataType === "slice";
}

function isStructValue(value: RuntimeValue): boolean {
  return value.dataType === "struct";
}

function makeInt(value: number): RuntimeValue {
  return { dataType: "int", value: Math.trunc(value) };
}

function makeFloat(value: number): RuntimeValue {
  return { dataType: "float64", value };
}

function makeString(value: string): RuntimeValue {
  return { dataType: "string", value };
}

function makeBool(value: boolean): RuntimeValue {
  return { dataType: "bool", value };
}

function makeRune(value: string): RuntimeValue {
  return { dataType: "rune", value };
}

function makeArray(
  elementType: NonVoidTypeName,
  size: number,
  elements: RuntimeValue[]
): RuntimeValue {
  return {
    dataType: "array",
    value: elements,
    elementType,
    size
  };
}

function makeSlice(
  elementType: NonVoidTypeName,
  elements: RuntimeValue[]
): RuntimeValue {
  return {
    dataType: "slice",
    value: elements,
    elementType
  };
}

function makeStruct(
  structName: string,
  fields: Record<string, RuntimeValue>
): RuntimeValue {
  return {
    dataType: "struct",
    value: fields,
    structName
  };
}

function defaultValueForPrimitive(dataType: PrimitiveType): RuntimeValue {
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

function cloneValue(value: RuntimeValue): RuntimeValue {
  if (isArrayValue(value)) {
    const clonedElements = (value.value as RuntimeValue[]).map((item) => cloneValue(item));
    return makeArray(value.elementType as NonVoidTypeName, value.size as number, clonedElements);
  }

  if (isSliceValue(value)) {
    const clonedElements = (value.value as RuntimeValue[]).map((item) => cloneValue(item));
    return makeSlice(value.elementType as NonVoidTypeName, clonedElements);
  }

  if (isStructValue(value)) {
    const originalFields = value.value as Record<string, RuntimeValue>;
    const clonedFields: Record<string, RuntimeValue> = {};

    for (const key of Object.keys(originalFields)) {
      clonedFields[key] = cloneValue(originalFields[key]);
    }

    return makeStruct(value.structName as string, clonedFields);
  }

  return {
    dataType: value.dataType,
    value: value.value
  };
}

/*
  Para lecturas en expresiones:
  - slices y structs se comportan como referencia
  - arrays y primitivos se clonan
*/
function valueForRead(value: RuntimeValue): RuntimeValue {
  if (isSliceValue(value) || isStructValue(value)) {
    return value;
  }

  return cloneValue(value);
}

function typeStringFromValue(value: RuntimeValue): string {
  if (isArrayValue(value)) {
    return `[${value.size}]${value.elementType}`;
  }

  if (isSliceValue(value)) {
    return `[]${value.elementType}`;
  }

  if (isStructValue(value)) {
    return value.structName ?? "struct";
  }

  return value.dataType;
}

/*
  ============================================================
  VALORES POR DEFECTO
  ============================================================
*/

function createDefaultStructValue(
  structName: string,
  context: RuntimeContext,
  node: AstNode
): RuntimeValue | null {
  const structInfo = context.structs.get(structName);

  if (!structInfo) {
    context.errors.push({
      type: "Semantico",
      description: `El struct "${structName}" no ha sido declarado.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

  const fields: Record<string, RuntimeValue> = {};

  for (const field of structInfo.fields) {
    const defaultFieldValue = defaultValueForTypeName(field.typeName, context, node);

    if (!defaultFieldValue) {
      return null;
    }

    fields[field.name] = defaultFieldValue;
  }

  return makeStruct(structName, fields);
}

function defaultValueForTypeName(
  typeName: NonVoidTypeName,
  context: RuntimeContext,
  node: AstNode
): RuntimeValue | null {
  if (isPrimitiveTypeName(typeName)) {
    return defaultValueForPrimitive(typeName);
  }

  const sliceInfo = parseSliceTypeText(typeName);
  if (sliceInfo) {
    return makeSlice(sliceInfo.elementType, []);
  }

  const arrayInfo = parseArrayTypeText(typeName);
  if (arrayInfo) {
    const elements: RuntimeValue[] = [];

    for (let i = 0; i < arrayInfo.size; i++) {
      const item = defaultValueForTypeName(arrayInfo.elementType, context, node);

      if (!item) {
        return null;
      }

      elements.push(item);
    }

    return makeArray(arrayInfo.elementType, arrayInfo.size, elements);
  }

  return createDefaultStructValue(typeName, context, node);
}

function defaultValueFromTypeNode(
  typeNode: AstNode,
  context: RuntimeContext
): RuntimeValue | null {
  return defaultValueForTypeName(typeStringFromTypeNode(typeNode), context, typeNode);
}

/*
  ============================================================
  BÚSQUEDA DE VARIABLES Y ERRORES
  ============================================================
*/

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

/*
  ============================================================
  CONVERSIONES Y FORMATEO
  ============================================================
*/

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
  if (isArrayValue(value) || isSliceValue(value)) {
    const elements = (value.value as RuntimeValue[]).map((item) => formatValueForPrint(item));
    return `[${elements.join(", ")}]`;
  }

  if (isStructValue(value)) {
    const fields = value.value as Record<string, RuntimeValue>;
    const parts = Object.keys(fields).map((key) => `${key}: ${formatValueForPrint(fields[key])}`);
    return `${value.structName}{${parts.join(", ")}}`;
  }

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
    default:
      return String(value.value);
  }
}

function toIntLikeNumber(
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext,
  operator: string
): number | null {
  if (isArrayValue(value) || isSliceValue(value) || isStructValue(value)) {
    context.errors.push({
      type: "Semantico",
      description: `La operación "${operator}" no acepta valores de tipo ${typeStringFromValue(value)}.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

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
        description: `La operación "${operator}" no acepta valores de tipo ${typeStringFromValue(value)}.`,
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
  if (isArrayValue(value) || isSliceValue(value) || isStructValue(value)) {
    context.errors.push({
      type: "Semantico",
      description: `La operación "${operator}" no acepta valores de tipo ${typeStringFromValue(value)}.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

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
        description: `La operación "${operator}" no acepta valores de tipo ${typeStringFromValue(value)}.`,
        line: node.line,
        column: node.column
      });
      return null;
  }
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
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    context.errors.push({
      type: "Semantico",
      description: `No se puede comparar ${typeStringFromValue(left)} con ${typeStringFromValue(right)} usando "==".`,
      line: node.line,
      column: node.column
    });
    return null;
  }

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
    description: `No se puede comparar ${typeStringFromValue(left)} con ${typeStringFromValue(right)} usando "==".`,
    line: node.line,
    column: node.column
  });

  return null;
}

function getIndexedPosition(
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): number | null {
  if (value.dataType !== "int") {
    context.errors.push({
      type: "Semantico",
      description: "El índice debe ser int.",
      line: node.line,
      column: node.column
    });
    return null;
  }

  return Number(value.value);
}

/*
  ============================================================
  COERCIÓN DE TIPOS
  ============================================================
*/

function coercePrimitiveValue(
  expectedType: PrimitiveType,
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue | null {
  if (isArrayValue(value) || isSliceValue(value) || isStructValue(value)) {
    context.errors.push({
      type: "Semantico",
      description: `No se puede asignar un valor de tipo ${typeStringFromValue(value)} a una variable de tipo ${expectedType}.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

  if (expectedType === value.dataType) {
    return cloneValue(value);
  }

  if (expectedType === "float64" && value.dataType === "int") {
    return makeFloat(Number(value.value));
  }

  context.errors.push({
    type: "Semantico",
    description: `No se puede asignar un valor de tipo ${typeStringFromValue(value)} a una variable de tipo ${expectedType}.`,
    line: node.line,
    column: node.column
  });

  return null;
}

/*
  Regla importante:
  - primitives: por valor
  - arrays: por valor
  - slices: por referencia
  - structs: por referencia
*/
function coerceValueToTypeName(
  expectedType: NonVoidTypeName,
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue | null {
  if (isPrimitiveTypeName(expectedType)) {
    return coercePrimitiveValue(expectedType, value, node, context);
  }

  const sliceInfo = parseSliceTypeText(expectedType);
  if (sliceInfo) {
    if (!isSliceValue(value) || value.elementType !== sliceInfo.elementType) {
      context.errors.push({
        type: "Semantico",
        description: `No se puede asignar un valor de tipo ${typeStringFromValue(value)} a una variable de tipo ${expectedType}.`,
        line: node.line,
        column: node.column
      });
      return null;
    }

    return value;
  }

  const arrayInfo = parseArrayTypeText(expectedType);
  if (arrayInfo) {
    if (
      !isArrayValue(value) ||
      value.size !== arrayInfo.size ||
      value.elementType !== arrayInfo.elementType
    ) {
      context.errors.push({
        type: "Semantico",
        description: `No se puede asignar un valor de tipo ${typeStringFromValue(value)} a una variable de tipo ${expectedType}.`,
        line: node.line,
        column: node.column
      });
      return null;
    }

    return cloneValue(value);
  }

  if (!isStructValue(value) || value.structName !== expectedType) {
    context.errors.push({
      type: "Semantico",
      description: `No se puede asignar un valor de tipo ${typeStringFromValue(value)} a una variable de tipo ${expectedType}.`,
      line: node.line,
      column: node.column
    });
    return null;
  }

  return value;
}

function coerceValueToTypeNode(
  typeNode: AstNode,
  value: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue | null {
  return coerceValueToTypeName(typeStringFromTypeNode(typeNode), value, node, context);
}

function coerceValueToExistingValue(
  currentValue: RuntimeValue,
  newValue: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue | null {
  return coerceValueToTypeName(typeStringFromValue(currentValue), newValue, node, context);
}

/*
  ============================================================
  STRUCTS
  ============================================================
*/

function extractStructInfo(
  node: AstNode,
  context: RuntimeContext
): StructInfo | null {
  const name = node.value ?? "";
  const fields: StructFieldInfo[] = [];
  const fieldMap = new Map<string, StructFieldInfo>();

  for (const child of node.children) {
    if (child.kind !== "StructField") {
      continue;
    }

    const fieldName = child.value ?? "";
    const typeNode = child.children[0];

    if (!typeNode) {
      context.errors.push({
        type: "Semantico",
        description: `El campo "${fieldName}" del struct "${name}" está incompleto.`,
        line: child.line,
        column: child.column
      });
      continue;
    }

    if (fieldMap.has(fieldName)) {
      context.errors.push({
        type: "Semantico",
        description: `El campo "${fieldName}" está repetido en el struct "${name}".`,
        line: child.line,
        column: child.column
      });
      continue;
    }

    const info: StructFieldInfo = {
      name: fieldName,
      typeName: typeStringFromTypeNode(typeNode),
      line: child.line,
      column: child.column
    };

    fields.push(info);
    fieldMap.set(fieldName, info);
  }

  return {
    name,
    fields,
    fieldMap,
    node
  };
}

/*
  ============================================================
  EVALUADORES DE LITERALES DE COLECCIONES
  ============================================================
*/

/*
  Evalúa una expresión esperando un tipo específico.
  Esto es clave para soportar filas anónimas en:
    [][]int{
      {1,2,3},
      {4,5,6}
    }
*/
function evaluateValueForExpectedType(
  expectedType: NonVoidTypeName,
  exprNode: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  if (exprNode.kind === "AnonymousSliceLiteral") {
    const sliceInfo = parseSliceTypeText(expectedType);

    if (sliceInfo) {
      return evaluateAnonymousSliceLiteral(exprNode, sliceInfo.elementType, scope, context);
    }

    const arrayInfo = parseArrayTypeText(expectedType);

    if (arrayInfo) {
      return evaluateAnonymousArrayLiteral(exprNode, arrayInfo.size, arrayInfo.elementType, scope, context);
    }

    return pushSemanticError(
      context,
      exprNode,
      `No se puede usar una colección anónima para inicializar un valor de tipo ${expectedType}.`
    );
  }

  return evaluateExpression(exprNode, scope, context);
}

function evaluateAnonymousSliceLiteral(
  node: AstNode,
  elementType: NonVoidTypeName,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const items: RuntimeValue[] = [];

  for (const child of node.children) {
    const rawValue = evaluateValueForExpectedType(elementType, child, scope, context);
    const coerced = coerceValueToTypeName(elementType, rawValue, child, context);

    if (coerced) {
      items.push(coerced);
    } else {
      const fallback = defaultValueForTypeName(elementType, context, child);
      items.push(fallback ?? makeInt(0));
    }
  }

  return makeSlice(elementType, items);
}

function evaluateAnonymousArrayLiteral(
  node: AstNode,
  size: number,
  elementType: NonVoidTypeName,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const items: RuntimeValue[] = [];

  if (node.children.length > size) {
    context.errors.push({
      type: "Semantico",
      description: `El arreglo de tamaño ${size} no puede recibir ${node.children.length} valor(es) iniciales.`,
      line: node.line,
      column: node.column
    });
  }

  for (let i = 0; i < size; i++) {
    if (i < node.children.length) {
      const rawValue = evaluateValueForExpectedType(elementType, node.children[i], scope, context);
      const coerced = coerceValueToTypeName(elementType, rawValue, node.children[i], context);

      if (coerced) {
        items.push(coerced);
      } else {
        const fallback = defaultValueForTypeName(elementType, context, node.children[i]);
        items.push(fallback ?? makeInt(0));
      }
    } else {
      const fallback = defaultValueForTypeName(elementType, context, node);
      items.push(fallback ?? makeInt(0));
    }
  }

  return makeArray(elementType, size, items);
}

/*
  ============================================================
  BUILTINS
  ============================================================
*/

function evaluateBuiltinLen(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  if (node.children.length !== 1) {
    return pushSemanticError(
      context,
      node,
      'La función len espera exactamente 1 argumento.'
    );
  }

  const target = evaluateExpression(node.children[0], scope, context);

  if (isSliceValue(target) || isArrayValue(target)) {
    return makeInt((target.value as RuntimeValue[]).length);
  }

  return pushSemanticError(
    context,
    node,
    `La función len no acepta valores de tipo ${typeStringFromValue(target)}.`
  );
}

function evaluateBuiltinAppend(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  if (node.children.length !== 2) {
    return pushSemanticError(
      context,
      node,
      'La función append espera exactamente 2 argumentos.'
    );
  }

  const sliceValue = evaluateExpression(node.children[0], scope, context);

  if (!isSliceValue(sliceValue)) {
    return pushSemanticError(
      context,
      node,
      `La función append solo acepta slices como primer argumento, pero recibió ${typeStringFromValue(sliceValue)}.`
    );
  }

  const valueToAppend = evaluateExpression(node.children[1], scope, context);
  const coerced = coerceValueToTypeName(
    sliceValue.elementType as NonVoidTypeName,
    valueToAppend,
    node.children[1],
    context
  );

  if (!coerced) {
    return makeSlice(sliceValue.elementType as NonVoidTypeName, [
      ...(sliceValue.value as RuntimeValue[]).map((item) => item)
    ]);
  }

  const clonedItems = [...(sliceValue.value as RuntimeValue[])];
  clonedItems.push(coerced);

  return makeSlice(sliceValue.elementType as NonVoidTypeName, clonedItems);
}

function evaluateCallExpression(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const functionName = node.value ?? "";

  if (functionName === "len") {
    return evaluateBuiltinLen(node, scope, context);
  }

  if (functionName === "append") {
    return evaluateBuiltinAppend(node, scope, context);
  }

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

/*
  Esto corrige el caso:
    mostrar(personas)
  que es una llamada válida como sentencia, aunque no retorne nada.
*/
function executeCallStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): void {
  const functionName = node.value ?? "";

  if (functionName === "len" || functionName === "append") {
    evaluateCallExpression(node, scope, context);
    return;
  }

  const argValues = node.children.map((child) => evaluateExpression(child, scope, context));
  invokeFunction(functionName, argValues, node, context);
}

/*
  ============================================================
  LITERALES Y ACCESOS
  ============================================================
*/

function evaluateArrayLiteral(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const size = Number(node.value ?? "0");
  const typeNode = node.children[0];
  const elementType = typeStringFromTypeNode(typeNode);
  const providedExprs = node.children.slice(1);
  const elements: RuntimeValue[] = [];

  if (providedExprs.length > size) {
    context.errors.push({
      type: "Semantico",
      description: `El arreglo de tamaño ${size} no puede recibir ${providedExprs.length} valor(es) iniciales.`,
      line: node.line,
      column: node.column
    });
  }

  for (let i = 0; i < size; i++) {
    if (i < providedExprs.length) {
      const rawValue = evaluateValueForExpectedType(elementType, providedExprs[i], scope, context);
      const coerced = coerceValueToTypeName(elementType, rawValue, providedExprs[i], context);

      if (coerced) {
        elements.push(coerced);
      } else {
        const fallback = defaultValueForTypeName(elementType, context, providedExprs[i]);
        elements.push(fallback ?? makeInt(0));
      }
    } else {
      const fallback = defaultValueForTypeName(elementType, context, node);
      elements.push(fallback ?? makeInt(0));
    }
  }

  return makeArray(elementType, size, elements);
}

function evaluateSliceLiteral(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const typeNode = node.children[0];
  const elementType = typeStringFromTypeNode(typeNode);
  const exprNodes = node.children.slice(1);
  const elements: RuntimeValue[] = [];

  for (const exprNode of exprNodes) {
    const rawValue = evaluateValueForExpectedType(elementType, exprNode, scope, context);
    const coerced = coerceValueToTypeName(elementType, rawValue, exprNode, context);

    if (coerced) {
      elements.push(coerced);
    } else {
      const fallback = defaultValueForTypeName(elementType, context, exprNode);
      elements.push(fallback ?? makeInt(0));
    }
  }

  return makeSlice(elementType, elements);
}

function evaluateStructLiteral(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const structName = node.value ?? "";
  const baseValue = createDefaultStructValue(structName, context, node);

  if (!baseValue || !isStructValue(baseValue)) {
    return makeInt(0);
  }

  const structInfo = context.structs.get(structName);
  const fieldsObject = baseValue.value as Record<string, RuntimeValue>;
  const seen = new Set<string>();

  if (!structInfo) {
    return makeInt(0);
  }

  for (const initNode of node.children) {
    const fieldName = initNode.value ?? "";
    const exprNode = initNode.children[0];
    const fieldInfo = structInfo.fieldMap.get(fieldName);

    if (!fieldInfo) {
      context.errors.push({
        type: "Semantico",
        description: `El campo "${fieldName}" no existe en el struct "${structName}".`,
        line: initNode.line,
        column: initNode.column
      });
      continue;
    }

    if (!exprNode) {
      context.errors.push({
        type: "Semantico",
        description: `La inicialización del campo "${fieldName}" está incompleta.`,
        line: initNode.line,
        column: initNode.column
      });
      continue;
    }

    if (seen.has(fieldName)) {
      context.errors.push({
        type: "Semantico",
        description: `El campo "${fieldName}" está repetido en el literal del struct "${structName}".`,
        line: initNode.line,
        column: initNode.column
      });
      continue;
    }

    seen.add(fieldName);

    const evaluated = evaluateExpression(exprNode, scope, context);
    const coerced = coerceValueToTypeName(fieldInfo.typeName, evaluated, exprNode, context);

    if (coerced) {
      fieldsObject[fieldName] = coerced;
    }
  }

  return baseValue;
}

function evaluateIndexedAccess(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const baseNode = node.children[0];
  const indexNode = node.children[1];

  if (!baseNode || !indexNode) {
    return pushSemanticError(context, node, "El acceso por índice está incompleto.");
  }

  const baseValue = evaluateExpression(baseNode, scope, context);

  if (!isArrayValue(baseValue) && !isSliceValue(baseValue)) {
    return pushSemanticError(
      context,
      node,
      `No se puede indexar un valor de tipo ${typeStringFromValue(baseValue)}.`
    );
  }

  const indexValue = evaluateExpression(indexNode, scope, context);
  const index = getIndexedPosition(indexValue, indexNode, context);

  if (index === null) {
    return makeInt(0);
  }

  const items = baseValue.value as RuntimeValue[];

  if (index < 0 || index >= items.length) {
    return pushSemanticError(
      context,
      indexNode,
      `El índice ${index} está fuera del rango válido.`
    );
  }

  return valueForRead(items[index]);
}

function evaluateFieldAccess(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): RuntimeValue {
  const baseNode = node.children[0];
  const fieldName = node.value ?? "";

  if (!baseNode) {
    return pushSemanticError(context, node, "El acceso a campo está incompleto.");
  }

  const baseValue = evaluateExpression(baseNode, scope, context);

  if (!isStructValue(baseValue)) {
    return pushSemanticError(
      context,
      node,
      `No se puede acceder a un campo sobre un valor de tipo ${typeStringFromValue(baseValue)}.`
    );
  }

  const fieldsObject = baseValue.value as Record<string, RuntimeValue>;

  if (!(fieldName in fieldsObject)) {
    return pushSemanticError(
      context,
      node,
      `El campo "${fieldName}" no existe en el struct "${baseValue.structName}".`
    );
  }

  return valueForRead(fieldsObject[fieldName]);
}

/*
  ============================================================
  EXPRESIONES
  ============================================================
*/

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

      return valueForRead(resolved);
    }

    case "CallExpression":
      return evaluateCallExpression(node, scope, context);

    case "ArrayLiteral":
      return evaluateArrayLiteral(node, scope, context);

    case "SliceLiteral":
      return evaluateSliceLiteral(node, scope, context);

    case "StructLiteral":
      return evaluateStructLiteral(node, scope, context);

    case "ArrayAccess":
      return evaluateIndexedAccess(node, scope, context);

    case "FieldAccess":
      return evaluateFieldAccess(node, scope, context);

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

/*
  ============================================================
  REFERENCIAS ASIGNABLES
  ============================================================
*/

function resolveAssignableReference(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): AssignableReference | null {
  switch (node.kind) {
    case "Identifier": {
      const frame = findVariableFrame(scope, node.value ?? "");

      if (!frame) {
        context.errors.push({
          type: "Semantico",
          description: `La variable "${node.value}" no ha sido declarada.`,
          line: node.line,
          column: node.column
        });
        return null;
      }

      const currentValue = frame.values.get(node.value ?? "");

      if (!currentValue) {
        context.errors.push({
          type: "Semantico",
          description: `La variable "${node.value}" no pudo resolverse correctamente.`,
          line: node.line,
          column: node.column
        });
        return null;
      }

      return {
        currentValue,
        setValue(nextValue: RuntimeValue) {
          frame.values.set(node.value ?? "", nextValue);
        }
      };
    }

    case "ArrayAccess": {
      const baseNode = node.children[0];
      const indexNode = node.children[1];

      if (!baseNode || !indexNode) {
        context.errors.push({
          type: "Semantico",
          description: "La referencia indexada está incompleta.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      const baseRef = resolveAssignableReference(baseNode, scope, context);

      if (!baseRef) {
        return null;
      }

      if (!isArrayValue(baseRef.currentValue) && !isSliceValue(baseRef.currentValue)) {
        context.errors.push({
          type: "Semantico",
          description: `No se puede indexar un valor de tipo ${typeStringFromValue(baseRef.currentValue)}.`,
          line: node.line,
          column: node.column
        });
        return null;
      }

      const indexValue = evaluateExpression(indexNode, scope, context);
      const index = getIndexedPosition(indexValue, indexNode, context);

      if (index === null) {
        return null;
      }

      const items = baseRef.currentValue.value as RuntimeValue[];

      if (index < 0 || index >= items.length) {
        context.errors.push({
          type: "Semantico",
          description: `El índice ${index} está fuera del rango válido.`,
          line: indexNode.line,
          column: indexNode.column
        });
        return null;
      }

      const currentValue = items[index];

      return {
        currentValue,
        setValue(nextValue: RuntimeValue) {
          items[index] = nextValue;
        }
      };
    }

    case "FieldAccess": {
      const baseNode = node.children[0];
      const fieldName = node.value ?? "";

      if (!baseNode) {
        context.errors.push({
          type: "Semantico",
          description: "La referencia a campo está incompleta.",
          line: node.line,
          column: node.column
        });
        return null;
      }

      const baseRef = resolveAssignableReference(baseNode, scope, context);

      if (!baseRef) {
        return null;
      }

      if (!isStructValue(baseRef.currentValue)) {
        context.errors.push({
          type: "Semantico",
          description: `No se puede acceder a un campo sobre un valor de tipo ${typeStringFromValue(baseRef.currentValue)}.`,
          line: node.line,
          column: node.column
        });
        return null;
      }

      const fieldsObject = baseRef.currentValue.value as Record<string, RuntimeValue>;

      if (!(fieldName in fieldsObject)) {
        context.errors.push({
          type: "Semantico",
          description: `El campo "${fieldName}" no existe en el struct "${baseRef.currentValue.structName}".`,
          line: node.line,
          column: node.column
        });
        return null;
      }

      const currentValue = fieldsObject[fieldName];

      return {
        currentValue,
        setValue(nextValue: RuntimeValue) {
          fieldsObject[fieldName] = nextValue;
        }
      };
    }

    default:
      context.errors.push({
        type: "Semantico",
        description: "El destino de asignación no es válido.",
        line: node.line,
        column: node.column
      });
      return null;
  }
}

/*
  ============================================================
  FUNCIONES
  ============================================================
*/

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
    const typeName = typeStringFromTypeNode(typeNode);

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
      typeName,
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

    return defaultValueForTypeName(fn.returnType, context, callNode) ?? makeInt(0);
  }

  context.callCounter += 1;
  const callScope = createScope(`${functionName}@call#${context.callCounter}`, context.globalScope);

  for (let i = 0; i < fn.params.length; i++) {
    const param = fn.params[i];
    const argValue = argValues[i];
    const coerced = coerceValueToTypeName(param.typeName, argValue, callNode, context);

    if (!coerced) {
      if (fn.returnType === "void") {
        return null;
      }

      return defaultValueForTypeName(fn.returnType, context, callNode) ?? makeInt(0);
    }

    callScope.values.set(param.name, coerced);

    registerSymbol(
      context.symbolTable,
      param.name,
      "Parámetro",
      param.typeName,
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

    return defaultValueForTypeName(fn.returnType, context, signal.node) ?? makeInt(0);
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

    return defaultValueForTypeName(fn.returnType, context, signal.node) ?? makeInt(0);
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

    return defaultValueForTypeName(fn.returnType, context, fn.node) ?? makeInt(0);
  }

  if (signal.value === undefined) {
    context.errors.push({
      type: "Semantico",
      description: `La función "${functionName}" debe retornar un valor de tipo ${fn.returnType}.`,
      line: signal.node.line,
      column: signal.node.column
    });

    return defaultValueForTypeName(fn.returnType, context, signal.node) ?? makeInt(0);
  }

  const coercedReturn = coerceValueToTypeName(fn.returnType, signal.value, signal.node, context);

  if (!coercedReturn) {
    return defaultValueForTypeName(fn.returnType, context, signal.node) ?? makeInt(0);
  }

  return coercedReturn;
}

/*
  ============================================================
  EJECUTORES DE SENTENCIAS
  ============================================================
*/

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
  const conditionBool = evaluateConditionBoolean(conditionValue, conditionNode, context, "if");

  if (conditionBool === null) {
    return null;
  }

  if (conditionBool) {
    return executeNestedBlock(thenBlock, scope, context, `if@${node.line}:${node.column}`);
  }

  if (!elseBranch) {
    return null;
  }

  const elseNode = elseBranch.children[0];

  if (!elseNode) {
    return null;
  }

  if (elseNode.kind === "Block") {
    return executeNestedBlock(elseNode, scope, context, `else@${elseNode.line}:${elseNode.column}`);
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

  if (
    isArrayValue(currentValue) ||
    isSliceValue(currentValue) ||
    isStructValue(currentValue)
  ) {
    context.errors.push({
      type: "Semantico",
      description: `La operación ${delta > 0 ? "++" : "--"} no se permite sobre arreglos, slices o structs.`,
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
      const conditionBool = evaluateConditionBoolean(conditionValue, conditionNode, context, "for");

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
        const conditionBool = evaluateConditionBoolean(conditionValue, conditionNode, context, "for");

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

/*
  for índice, valor := range slice { ... }
*/
function executeForRangeStatement(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): StatementResult {
  const indexNode = node.children[0];
  const valueNode = node.children[1];
  const targetNode = node.children[2];
  const blockNode = node.children[3];

  if (!indexNode || !valueNode || !targetNode || !blockNode) {
    context.errors.push({
      type: "Semantico",
      description: "La sentencia for-range está incompleta.",
      line: node.line,
      column: node.column
    });
    return null;
  }

  const indexName = indexNode.value ?? "";
  const valueName = valueNode.value ?? "";

  if (indexName === valueName) {
    context.errors.push({
      type: "Semantico",
      description: "Las variables índice y valor del range no pueden tener el mismo nombre.",
      line: node.line,
      column: node.column
    });
    return null;
  }

  const iterable = evaluateExpression(targetNode, scope, context);

  if (!isSliceValue(iterable) && !isArrayValue(iterable)) {
    context.errors.push({
      type: "Semantico",
      description: `La sentencia range solo acepta arrays o slices, pero recibió ${typeStringFromValue(iterable)}.`,
      line: targetNode.line,
      column: targetNode.column
    });
    return null;
  }

  const loopScope = createScope(`range@${node.line}:${node.column}`, scope);
  const items = iterable.value as RuntimeValue[];
  const elementType = iterable.elementType ?? "int";

  if (loopScope.values.has(indexName) || loopScope.values.has(valueName)) {
    context.errors.push({
      type: "Semantico",
      description: "Las variables del range ya existen en el ámbito actual.",
      line: node.line,
      column: node.column
    });
    return null;
  }

  loopScope.values.set(indexName, makeInt(0));
  registerSymbol(
    context.symbolTable,
    indexName,
    "Variable",
    "int",
    loopScope.name,
    indexNode.line,
    indexNode.column
  );

  const defaultVal = defaultValueForTypeName(elementType, context, valueNode) ?? makeInt(0);
  loopScope.values.set(valueName, defaultVal);
  registerSymbol(
    context.symbolTable,
    valueName,
    "Variable",
    elementType,
    loopScope.name,
    valueNode.line,
    valueNode.column
  );

  for (let i = 0; i < items.length; i++) {
    loopScope.values.set(indexName, makeInt(i));
    loopScope.values.set(valueName, valueForRead(items[i]));

    const bodySignal = executeNestedBlock(
      blockNode,
      loopScope,
      context,
      `range-body@${node.line}:${node.column}#${i}`
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

  return null;
}

function executeAssignment(
  node: AstNode,
  scope: ScopeFrame,
  context: RuntimeContext
): void {
  const targetNode = node.children[0];
  const valueNode = node.children[1];

  if (!targetNode || !valueNode) {
    context.errors.push({
      type: "Semantico",
      description: "La asignación está incompleta.",
      line: node.line,
      column: node.column
    });
    return;
  }

  const ref = resolveAssignableReference(targetNode, scope, context);

  if (!ref) {
    return;
  }

  const evaluated = evaluateExpression(valueNode, scope, context);
  const coerced = coerceValueToExistingValue(ref.currentValue, evaluated, valueNode, context);

  if (!coerced) {
    return;
  }

  ref.setValue(coerced);
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

      if (exprNode) {
        if (exprNode.kind === "CallExpression") {
          executeCallStatement(exprNode, scope, context);
        } else {
          evaluateExpression(exprNode, scope, context);
        }
      }

      return null;
    }

    case "IfStatement":
      return executeIfStatement(node, scope, context);

    case "ForStatement":
      return executeForStatement(node, scope, context);

    case "ForRangeStatement":
      return executeForRangeStatement(node, scope, context);

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
        finalValue = coerceValueToTypeNode(typeNode, exprValue, exprNode, context);

        if (!finalValue) {
          return null;
        }
      } else {
        finalValue = defaultValueFromTypeNode(typeNode, context);

        if (!finalValue) {
          return null;
        }
      }

      scope.values.set(varName, finalValue);

      registerSymbol(
        context.symbolTable,
        varName,
        "Variable",
        typeStringFromTypeNode(typeNode),
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
        typeStringFromValue(exprValue),
        scope.name,
        idNode.line,
        idNode.column
      );

      return null;
    }

    case "Assignment":
      executeAssignment(node, scope, context);
      return null;

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

/*
  ============================================================
  EJECUCIÓN PRINCIPAL
  ============================================================
*/

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
    structs: new Map<string, StructInfo>(),
    symbolTable: [],
    consoleLines: [],
    errors: [],
    globalScope,
    callCounter: 0
  };

  const astChildren = Array.isArray(ast.children) ? ast.children : [];

  for (const child of astChildren) {
    if (child.kind !== "StructDeclaration") {
      continue;
    }

    const structInfo = extractStructInfo(child, context);

    if (!structInfo) {
      continue;
    }

    if (context.structs.has(structInfo.name)) {
      context.errors.push({
        type: "Semantico",
        description: `El struct "${structInfo.name}" ya fue declarado.`,
        line: child.line,
        column: child.column
      });
      continue;
    }

    context.structs.set(structInfo.name, structInfo);

    registerSymbol(
      context.symbolTable,
      structInfo.name,
      "Struct",
      "struct",
      "Global",
      child.line,
      child.column
    );
  }

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

  invokeFunction("main", [], mainFn.node, context);

  return {
    console: context.consoleLines.join("\n"),
    errors: context.errors,
    symbolTable: context.symbolTable,
    ast,
    astDot: astToDot(ast)
  };
}

/*
  ============================================================
  OPERACIONES ARITMÉTICAS Y LÓGICAS
  ============================================================
*/

function evaluateAddition(
  left: RuntimeValue,
  right: RuntimeValue,
  node: AstNode,
  context: RuntimeContext
): RuntimeValue {
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    return pushSemanticError(
      context,
      node,
      'La operación "+" no es válida con arreglos, slices o structs.'
    );
  }

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
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    return pushSemanticError(
      context,
      node,
      'La operación "-" no es válida con arreglos, slices o structs.'
    );
  }

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
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    return pushSemanticError(
      context,
      node,
      'La operación "*" no es válida con arreglos, slices o structs.'
    );
  }

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
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    return pushSemanticError(
      context,
      node,
      'La operación "/" no es válida con arreglos, slices o structs.'
    );
  }

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
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    return pushSemanticError(
      context,
      node,
      'La operación "%" no es válida con arreglos, slices o structs.'
    );
  }

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
  if (isArrayValue(value) || isSliceValue(value) || isStructValue(value)) {
    return pushSemanticError(
      context,
      node,
      "La negación unaria no se aplica a arreglos, slices o structs."
    );
  }

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
  if (
    isArrayValue(left) ||
    isArrayValue(right) ||
    isSliceValue(left) ||
    isSliceValue(right) ||
    isStructValue(left) ||
    isStructValue(right)
  ) {
    return pushSemanticError(
      context,
      node,
      `No se puede comparar ${typeStringFromValue(left)} con ${typeStringFromValue(right)} usando "${operator}".`
    );
  }

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
      description: `No se puede comparar ${typeStringFromValue(left)} con ${typeStringFromValue(right)} usando "${operator}".`,
      line: node.line,
      column: node.column
    });
    return makeInt(0);
  }

  return makeBool(Boolean(result));
}