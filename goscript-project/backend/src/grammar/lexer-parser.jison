%{
/*
  ============================================================
  HELPERS DEL AST
  ============================================================
*/

function safeLoc(loc) {
  return loc || { first_line: 1, first_column: 0 };
}

function createNode(kind, value, loc, children) {
  var safe = safeLoc(loc);

  return {
    kind: kind,
    value: value === null || value === undefined ? undefined : String(value),
    line: typeof safe.first_line === "number" ? safe.first_line : 1,
    column: typeof safe.first_column === "number" ? safe.first_column + 1 : 1,
    children: Array.isArray(children) ? children : []
  };
}

/* Clona un nodo AST para reutilizarlo en += y -= sin compartir referencia */
function cloneNode(node) {
  return JSON.parse(JSON.stringify(node));
}

function decodeString(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return text.substring(1, text.length - 1);
  }
}

function decodeRune(text) {
  var inner = text.substring(1, text.length - 1);

  if (inner[0] === "\\") {
    switch (inner[1]) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      default: return inner[1];
    }
  }

  return inner;
}

function typeNodeToText(typeNode) {
  if (!typeNode) return "int";

  if (typeNode.kind === "Type" || typeNode.kind === "NamedType") {
    return typeNode.value || "int";
  }

  if (typeNode.kind === "ArrayType") {
    return "[" + (typeNode.value || "0") + "]" + typeNodeToText(typeNode.children[0]);
  }

  if (typeNode.kind === "SliceType") {
    return "[]" + typeNodeToText(typeNode.children[0]);
  }

  return typeNode.value || "int";
}

function adaptInitializerForTypedDeclaration(typeNode, exprNode, loc) {
  if (!exprNode) return exprNode;

  if (exprNode.kind === "AnonymousStructLiteral" && typeNode && typeNode.kind === "NamedType") {
    return createNode("StructLiteral", typeNode.value, loc, exprNode.children);
  }

  return exprNode;
}

function applyPostfixOps(base, ops) {
  var current = base;

  if (!Array.isArray(ops)) {
    return base;
  }

  for (var i = 0; i < ops.length; i++) {
    var op = ops[i];

    if (op.kind === "index") {
      current = createNode("ArrayAccess", null, op.loc, [current, op.expr]);
    } else if (op.kind === "field") {
      current = createNode("FieldAccess", op.name, op.loc, [current]);
    }
  }

  return current;
}
%}

%locations

%token FUNC VAR TYPE STRUCT FMT PRINTLN STRCONV STRINGS SLICES REFLECT TYPEOF TYPE_INT TYPE_FLOAT64 TYPE_STRING TYPE_BOOL TYPE_RUNE
%token IDENTIFIER STRING INT FLOAT BOOL RUNE NIL DECLARE EOF
%token EQ NEQ GTE LTE AND OR NOT IF ELSE FOR INC DEC BREAK CONTINUE RETURN RANGE
%token SWITCH CASE DEFAULT
%token PLUS_ASSIGN MINUS_ASSIGN

%left OR
%left AND
%left EQ NEQ
%left '<' '>' GTE LTE
%left '+' '-'
%left '*' '/' '%'
%right NOT UMINUS

%start program

%lex
%options flex

%%
[ \t\r\n]+                                      /* ignorar espacios */
"//"[^\n]*                                      /* comentario una línea */

"func"                                          return 'FUNC';
"var"                                           return 'VAR';
"type"                                          return 'TYPE';
"struct"                                        return 'STRUCT';
"fmt"                                           return 'FMT';
"Println"                                       return 'PRINTLN';
"strconv"                                      return 'STRCONV';
"strings"                                       return 'STRINGS';
"slices"                                        return 'SLICES';
"reflect"                                       return 'REFLECT';
"TypeOf"                                        return 'TYPEOF';
"if"                                            return 'IF';
"else"                                          return 'ELSE';
"for"                                           return 'FOR';
"break"                                         return 'BREAK';
"continue"                                      return 'CONTINUE';
"return"                                        return 'RETURN';
"range"                                         return 'RANGE';
"switch"                                        return 'SWITCH';
"case"                                          return 'CASE';
"default"                                       return 'DEFAULT';

"int"                                           return 'TYPE_INT';
"float64"                                       return 'TYPE_FLOAT64';
"string"                                        return 'TYPE_STRING';
"bool"                                          return 'TYPE_BOOL';
"rune"                                          return 'TYPE_RUNE';

"true"|"false"                                  return 'BOOL';
"nil"                                           return 'NIL';

":="                                            return 'DECLARE';
"=="                                            return 'EQ';
"!="                                            return 'NEQ';
">="                                            return 'GTE';
"<="                                            return 'LTE';
"&&"                                            return 'AND';
"||"                                            return 'OR';
"++"                                            return 'INC';
"--"                                            return 'DEC';
"+="                                            return 'PLUS_ASSIGN';
"-="                                            return 'MINUS_ASSIGN';

"!"                                             return 'NOT';
":"                                             return ':';
"="                                             return '=';
","                                             return ',';
";"                                             return ';';
"."                                             return '.';
"("                                             return '(';
")"                                             return ')';
"{"                                             return '{';
"}"                                             return '}';
"["                                             return '[';
"]"                                             return ']';
"+"                                             return '+';
"-"                                             return '-';
"*"                                             return '*';
"/"                                             return '/';
"%"                                             return '%';
">"                                             return '>';
"<"                                             return '<';

[0-9]+\.[0-9]+                                  return 'FLOAT';
[0-9]+                                          return 'INT';

\"([^\\"]|\\["\\nrt])*\"                        return 'STRING';
\'([^\\']|\\[nrt\\'"\\])*\'                     return 'RUNE';

[a-zA-Z_][a-zA-Z0-9_]*                          return 'IDENTIFIER';

<<EOF>>                                         return 'EOF';

. {
  yy.shared = yy.shared || {};
  yy.shared.lexicalErrors = yy.shared.lexicalErrors || [];

  yy.shared.lexicalErrors.push({
    type: 'Lexico',
    description: 'El símbolo "' + yytext + '" no es aceptado en el lenguaje.',
    line: yylloc.first_line || 1,
    column: (yylloc.first_column || 0) + 1
  });

  return this.lex();
}
/lex

%%

/*
  ============================================================
  INICIO
  ============================================================
*/

program
    : top_level_list EOF
        {
          yy.shared = yy.shared || {};
          yy.shared.ast = createNode('Program', null, @1, $1);
          $$ = yy.shared.ast;
        }
    ;

top_level_list
    : top_level_list top_level_decl
        { $$ = $1.concat([$2]); }
    | top_level_decl
        { $$ = [$1]; }
    ;

top_level_decl
    : function_decl
        { $$ = $1; }
    | struct_decl
        { $$ = $1; }
    ;

/*
  ============================================================
  STRUCTS
  ============================================================
  Soporta:
    type Persona struct { ... }
    struct Persona { ... }
*/

struct_decl
    : TYPE IDENTIFIER STRUCT '{' struct_field_items_opt '}'
        {
          $$ = createNode('StructDeclaration', $2, @2, $5);
        }
    | STRUCT IDENTIFIER '{' struct_field_items_opt '}'
        {
          $$ = createNode('StructDeclaration', $2, @2, $4);
        }
    ;

struct_field_items_opt
    : struct_field_items
        { $$ = $1; }
    |
        { $$ = []; }
    ;

struct_field_items
    : struct_field_items struct_field_item
        { $$ = $1.concat([$2]); }
    | struct_field_item
        { $$ = [$1]; }
    ;

struct_field_item
    : struct_field_decl struct_field_sep_opt
        { $$ = $1; }
    ;

struct_field_sep_opt
    : ';'
        { $$ = null; }
    |
        { $$ = null; }
    ;

/*
  Soporta ambos estilos:
    nombre string
    string nombre
*/
struct_field_decl
    : field_type IDENTIFIER
        {
          $$ = createNode('StructField', $2, @2, [$1]);
        }
    ;

field_type
    : type_spec
        { $$ = $1; }
    | named_type
        { $$ = $1; }
    | slice_type
        { $$ = $1; }
    | array_type
        { $$ = $1; }
    ;

/*
  ============================================================
  FUNCIONES
  ============================================================
*/

function_decl
    : FUNC IDENTIFIER '(' param_list_opt ')' return_type_opt block
        {
          $$ = createNode('FunctionDeclaration', $2, @2, [
            createNode('Parameters', null, @4, $4),
            $6,
            $7
          ]);
        }
    ;

param_list_opt
    : param_list
        { $$ = $1; }
    |
        { $$ = []; }
    ;

param_list
    : param_list ',' param_decl
        { $$ = $1.concat([$3]); }
    | param_decl
        { $$ = [$1]; }
    ;

param_decl
    : IDENTIFIER callable_type
        {
          $$ = createNode('Parameter', null, @1, [
            createNode('Identifier', $1, @1, []),
            $2
          ]);
        }
    ;

return_type_opt
    : callable_type
        {
          $$ = createNode('ReturnType', typeNodeToText($1), @1, [$1]);
        }
    |
        { $$ = createNode('ReturnType', 'void', null, []); }
    ;

callable_type
    : type_spec
        { $$ = $1; }
    | named_type
        { $$ = $1; }
    | slice_type
        { $$ = $1; }
    | array_type
        { $$ = $1; }
    ;

/*
  ============================================================
  BLOQUES E INSTRUCCIONES
  ============================================================
*/

block
    : '{' stmt_list '}'
        { $$ = createNode('Block', null, @1, $2); }
    ;

stmt_list
    : stmt_list statement stmt_terminator_opt
        { $$ = $1.concat([$2]); }
    |
        { $$ = []; }
    ;

stmt_terminator_opt
    : ';'
        { $$ = null; }
    |
        { $$ = null; }
    ;

statement
    : println_stmt
        { $$ = $1; }
    | var_decl
        { $$ = $1; }
    | typed_decl
        { $$ = $1; }
    | assignment
        { $$ = $1; }
    | identifier_statement
        { $$ = $1; }
    | if_stmt
        { $$ = $1; }
    | for_stmt
        { $$ = $1; }
    | switch_stmt
        { $$ = $1; }
    | break_stmt
        { $$ = $1; }
    | continue_stmt
        { $$ = $1; }
    | return_stmt
        { $$ = $1; }
    | block
        { $$ = $1; }
    ;

/*
  ============================================================
  PRINTLN
  ============================================================
*/

println_stmt
    : FMT '.' PRINTLN '(' expr_list_opt ')'
        { $$ = createNode('PrintlnStatement', null, @1, $5); }
    ;

/*
  ============================================================
  IF
  ============================================================
*/

if_stmt
    : IF expression_no_struct block else_part_opt
        {
          var children = [$2, $3];
          if ($4) {
            children.push($4);
          }
          $$ = createNode('IfStatement', null, @1, children);
        }
    ;

else_part_opt
    : ELSE if_stmt
        { $$ = createNode('ElseBranch', null, @1, [$2]); }
    | ELSE block
        { $$ = createNode('ElseBranch', null, @1, [$2]); }
    |
        { $$ = null; }
    ;

/*
  ============================================================
  FOR
  ============================================================
  Soporta:
    for condicion { ... }
    for init ; cond ; update { ... }
    for ; cond ; update { ... }
    for i, valor := range numeros { ... }
    for i := range numeros { ... }
    for _, valor := range numeros { ... }
    for i, _ := range numeros { ... }

  IMPORTANTE:
  Esta versión evita el conflicto de:
    for contador < 5 { ... }

  porque ya no usa un init opcional "codicioso" antes de decidir
  si es for clásico o for por condición.
*/

for_stmt
    : FOR range_clause block
        {
          $$ = createNode('ForRangeStatement', null, @1, [
            $2.binding,
            $2.iterable,
            $3
          ]);
        }
    | FOR for_classic_header block
        {
          $$ = createNode('ForStatement', 'classic', @1, [
            $2.init,
            $2.condition,
            $2.update,
            $3
          ]);
        }
    | FOR expression block
        {
          $$ = createNode('ForStatement', 'condition', @1, [$2, $3]);
        }
    ;

/*
  IMPORTANTE:
  Aquí el DECLARE y RANGE ya van dentro de la misma regla.
  Eso evita que IDENTIFIER se reduzca antes de tiempo.
*/
range_clause
    : IDENTIFIER DECLARE RANGE range_iterable
        {
          var leftNode = createNode('Identifier', $1, @1, []);
          $$ = {
            binding: createNode('RangeBinding', 'single', @1, [leftNode]),
            iterable: $4
          };
        }
    | IDENTIFIER ',' IDENTIFIER DECLARE RANGE range_iterable
        {
          var leftNode = createNode('Identifier', $1, @1, []);
          var rightNode = createNode('Identifier', $3, @3, []);
          $$ = {
            binding: createNode('RangeBinding', 'pair', @1, [leftNode, rightNode]),
            iterable: $6
          };
        }
    ;

range_iterable
    : range_iterable '.' IDENTIFIER
        {
          $$ = createNode('FieldAccess', $3, @2, [$1]);
        }
    | range_iterable '[' expression ']'
        {
          $$ = createNode('ArrayAccess', null, @2, [$1, $3]);
        }
    | call_expr
        {
          $$ = $1;
        }
    | array_literal
        {
          $$ = $1;
        }
    | slice_literal
        {
          $$ = $1;
        }
    | literal
        {
          $$ = $1;
        }
    | IDENTIFIER
        {
          $$ = createNode('Identifier', $1, @1, []);
        }
    | '(' expression ')'
        {
          $$ = $2;
        }
    ;

/*
  Header del for clásico:
    for init ; cond ; update
    for ; cond ; update
*/
for_classic_header
    : for_init_required ';' for_condition_opt ';' for_update_opt
        {
          $$ = {
            init: $1 ? $1 : createNode('Empty', null, @1, []),
            condition: $3 ? $3 : createNode('Empty', null, @3, []),
            update: $5 ? $5 : createNode('Empty', null, @5, [])
          };
        }
    | ';' for_condition_opt ';' for_update_opt
        {
          $$ = {
            init: createNode('Empty', null, @1, []),
            condition: $2 ? $2 : createNode('Empty', null, @2, []),
            update: $4 ? $4 : createNode('Empty', null, @4, [])
          };
        }
    ;

/*
  OJO:
  Aquí NO usamos init opcional.
  Solo permitimos formas que realmente pueden iniciar
  un for clásico, para no chocar con:
    for contador < 5 { ... }
*/
for_init_required
    : var_decl
        { $$ = $1; }
    | typed_decl
        { $$ = $1; }
    | short_decl
        { $$ = $1; }
    | assignment
        { $$ = $1; }
    ;

for_condition_opt
    : expression
        { $$ = $1; }
    |
        { $$ = null; }
    ;

for_update_opt
    : assignment
        { $$ = $1; }
    | inc_stmt
        { $$ = $1; }
    | dec_stmt
        { $$ = $1; }
    |
        { $$ = null; }
    ;

/*
  Binding del range:
    for i, valor := range ...
    for i := range ...
    for _, valor := range ...
    for i, _ := range ...
*/


/*
  ============================================================
  SWITCH
  ============================================================
*/

switch_stmt
    : SWITCH switch_subject '{' case_clause_list_opt default_clause_opt '}'
        {
          var children = [$2];
          if ($4) {
            children = children.concat($4);
          }
          if ($5) {
            children.push($5);
          }
          $$ = createNode('SwitchStatement', null, @1, children);
        }
    ;

/*
  El sujeto del switch se separa del no-terminal "expression"
  para evitar el conflicto con literales de struct.

  Ejemplo del problema:
      switch nota {
          case 100:
              ...
      }

  Si usamos "expression", el parser intenta leer "nota { ... }"
  como si fuera un struct literal llamado "nota".
*/
switch_subject
    : switch_subject '.' IDENTIFIER
        {
          $$ = createNode('FieldAccess', $3, @2, [$1]);
        }
    | switch_subject '[' expression ']'
        {
          $$ = createNode('ArrayAccess', null, @2, [$1, $3]);
        }
    | call_expr
        { $$ = $1; }
    | literal
        { $$ = $1; }
    | IDENTIFIER
        { $$ = createNode('Identifier', $1, @1, []); }
    | '(' expression ')'
        { $$ = $2; }
    ;

case_clause_list_opt
    : case_clause_list
        { $$ = $1; }
    |
        { $$ = []; }
    ;

case_clause_list
    : case_clause_list case_clause
        { $$ = $1.concat([$2]); }
    | case_clause
        { $$ = [$1]; }
    ;

case_clause
    : CASE expr_list ':' case_stmt_list
        {
          $$ = createNode('CaseClause', null, @1, [
            createNode('CaseValues', null, @2, $2),
            createNode('Block', null, @1, $4)
          ]);
        }
    ;

default_clause_opt
    : DEFAULT ':' case_stmt_list
        {
          $$ = createNode('DefaultClause', null, @1, [
            createNode('Block', null, @1, $3)
          ]);
        }
    |
        { $$ = null; }
    ;

case_stmt_list
    : case_stmt_list statement stmt_terminator_opt
        { $$ = $1.concat([$2]); }
    |
        { $$ = []; }
    ;

/*
  ============================================================
  BREAK / CONTINUE / RETURN
  ============================================================
*/

break_stmt
    : BREAK
        {
          $$ = createNode('BreakStatement', null, @1, []);
        }
    ;

continue_stmt
    : CONTINUE
        {
          $$ = createNode('ContinueStatement', null, @1, []);
        }
    ;

return_stmt
    : RETURN return_expr_opt
        {
          var children = [];
          if ($2) {
            children.push($2);
          }
          $$ = createNode('ReturnStatement', null, @1, children);
        }
    ;

return_expr_opt
    : expression
        { $$ = $1; }
    |
        { $$ = null; }
    ;

/*
  ============================================================
  DECLARACIONES
  ============================================================
*/

var_decl
    : VAR IDENTIFIER declared_type '=' initializer
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $3,
            adaptInitializerForTypedDeclaration($3, $5, @5)
          ]);
        }
    | VAR IDENTIFIER declared_type
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $3
          ]);
        }
    ;

typed_decl
    : type_spec IDENTIFIER '=' initializer
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $1,
            adaptInitializerForTypedDeclaration($1, $4, @4)
          ]);
        }
    | type_spec IDENTIFIER
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $1
          ]);
        }
    | array_type IDENTIFIER '=' initializer
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $1,
            adaptInitializerForTypedDeclaration($1, $4, @4)
          ]);
        }
    | array_type IDENTIFIER
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $1
          ]);
        }
    | slice_type IDENTIFIER '=' initializer
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $1,
            adaptInitializerForTypedDeclaration($1, $4, @4)
          ]);
        }
    | slice_type IDENTIFIER
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $1
          ]);
        }
    ;

identifier_statement
    : IDENTIFIER DECLARE expression
        {
          $$ = createNode('ShortDeclaration', null, @1, [
            createNode('Identifier', $1, @1, []),
            $3
          ]);
        }

    | IDENTIFIER INC
        {
          $$ = createNode('IncStatement', null, @1, [
            createNode('Identifier', $1, @1, [])
          ]);
        }

    | IDENTIFIER DEC
        {
          $$ = createNode('DecStatement', null, @1, [
            createNode('Identifier', $1, @1, [])
          ]);
        }

    | IDENTIFIER '(' expr_list_opt ')'
        {
          $$ = createNode('ExpressionStatement', null, @1, [
            createNode('CallExpression', $1, @1, $3)
          ]);
        }

    | IDENTIFIER '=' expression
        {
          $$ = createNode('Assignment', null, @2, [
            createNode('Identifier', $1, @1, []),
            $3
          ]);
        }

    /* x += y  ==>  x = x + y */
    | IDENTIFIER PLUS_ASSIGN expression
        {
          $$ = createNode('Assignment', '=', @2, [
            createNode('Identifier', $1, @1, []),
            createNode('BinaryExpression', '+', @2, [
              createNode('Identifier', $1, @1, []),
              $3
            ])
          ]);
        }

    /* x -= y  ==>  x = x - y */
    | IDENTIFIER MINUS_ASSIGN expression
        {
          $$ = createNode('Assignment', '=', @2, [
            createNode('Identifier', $1, @1, []),
            createNode('BinaryExpression', '-', @2, [
              createNode('Identifier', $1, @1, []),
              $3
            ])
          ]);
        }

    | IDENTIFIER postfix_ops '=' expression
        {
          $$ = createNode('Assignment', null, @3, [
            applyPostfixOps(
              createNode('Identifier', $1, @1, []),
              $2
            ),
            $4
          ]);
        }

    /* arr[i] += y  o  persona.edad += y */
    | IDENTIFIER postfix_ops PLUS_ASSIGN expression
        {
          var leftNode = applyPostfixOps(
            createNode('Identifier', $1, @1, []),
            $2
          );

          $$ = createNode('Assignment', '=', @3, [
            leftNode,
            createNode('BinaryExpression', '+', @3, [
              cloneNode(leftNode),
              $4
            ])
          ]);
        }

    /* arr[i] -= y  o  persona.edad -= y */
    | IDENTIFIER postfix_ops MINUS_ASSIGN expression
        {
          var leftNode = applyPostfixOps(
            createNode('Identifier', $1, @1, []),
            $2
          );

          $$ = createNode('Assignment', '=', @3, [
            leftNode,
            createNode('BinaryExpression', '-', @3, [
              cloneNode(leftNode),
              $4
            ])
          ]);
        }

    | IDENTIFIER IDENTIFIER '=' initializer
        {
          var declaredNamedType = createNode('NamedType', $1, @1, []);
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            declaredNamedType,
            adaptInitializerForTypedDeclaration(declaredNamedType, $4, @4)
          ]);
        }

    | IDENTIFIER IDENTIFIER
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            createNode('NamedType', $1, @1, [])
          ]);
        }
    ;

postfix_ops
    : postfix_ops postfix_op
        { $$ = $1.concat([$2]); }
    | postfix_op
        { $$ = [$1]; }
    ;

postfix_op
    : '[' expression ']'
        {
          $$ = {
            kind: 'index',
            expr: $2,
            loc: @1
          };
        }
    | '.' IDENTIFIER
        {
          $$ = {
            kind: 'field',
            name: $2,
            loc: @1
          };
        }
    ;

short_decl
    : IDENTIFIER DECLARE expression
        {
          $$ = createNode('ShortDeclaration', null, @1, [
            createNode('Identifier', $1, @1, []),
            $3
          ]);
        }
    ;

assignment
    : assignable '=' expression
        {
          $$ = createNode('Assignment', '=', @2, [$1, $3]);
        }

    /* a += b  ==>  a = a + b */
    | assignable PLUS_ASSIGN expression
        {
          $$ = createNode(
            'Assignment',
            '=',
            @2,
            [
              $1,
              createNode(
                'BinaryExpression',
                '+',
                @2,
                [
                  cloneNode($1),
                  $3
                ]
              )
            ]
          );
        }

    /* a -= b  ==>  a = a - b */
    | assignable MINUS_ASSIGN expression
        {
          $$ = createNode(
            'Assignment',
            '=',
            @2,
            [
              $1,
              createNode(
                'BinaryExpression',
                '-',
                @2,
                [
                  cloneNode($1),
                  $3
                ]
              )
            ]
          );
        }
    ;

inc_stmt
    : IDENTIFIER INC
        {
          $$ = createNode('IncStatement', null, @1, [
            createNode('Identifier', $1, @1, [])
          ]);
        }
    ;

dec_stmt
    : IDENTIFIER DEC
        {
          $$ = createNode('DecStatement', null, @1, [
            createNode('Identifier', $1, @1, [])
          ]);
        }
    ;

initializer
    : expression
        { $$ = $1; }
    | anonymous_struct_literal
        { $$ = $1; }
    ;

anonymous_struct_literal
    : '{' struct_init_seq_opt '}'
        {
          $$ = createNode('AnonymousStructLiteral', null, @1, $2);
        }
    ;

assignable
    : IDENTIFIER
        { $$ = createNode('Identifier', $1, @1, []); }
    | assignable '[' expression ']'
        {
          $$ = createNode('ArrayAccess', null, @2, [$1, $3]);
        }
    | assignable '.' IDENTIFIER
        {
          $$ = createNode('FieldAccess', $3, @2, [$1]);
        }
    ;

/*
  ============================================================
  TIPOS
  ============================================================
*/

declared_type
    : type_spec
        { $$ = $1; }
    | array_type
        { $$ = $1; }
    | slice_type
        { $$ = $1; }
    | named_type
        { $$ = $1; }
    ;

named_type
    : IDENTIFIER
        {
          $$ = createNode('NamedType', $1, @1, []);
        }
    ;

array_type
    : '[' INT ']' array_element_type
        {
          $$ = createNode('ArrayType', $2, @1, [$4]);
        }
    ;

array_element_type
    : type_spec
        { $$ = $1; }
    | named_type
        { $$ = $1; }
    | slice_type
        { $$ = $1; }
    | array_type
        { $$ = $1; }
    ;

slice_type
    : '[' ']' slice_element_type
        {
          $$ = createNode('SliceType', null, @1, [$3]);
        }
    ;

slice_element_type
    : type_spec
        { $$ = $1; }
    | named_type
        { $$ = $1; }
    | array_type
        { $$ = $1; }
    | slice_type
        { $$ = $1; }
    ;

type_spec
    : TYPE_INT
        { $$ = createNode('Type', 'int', @1, []); }
    | TYPE_FLOAT64
        { $$ = createNode('Type', 'float64', @1, []); }
    | TYPE_STRING
        { $$ = createNode('Type', 'string', @1, []); }
    | TYPE_BOOL
        { $$ = createNode('Type', 'bool', @1, []); }
    | TYPE_RUNE
        { $$ = createNode('Type', 'rune', @1, []); }
    ;

/*
  ============================================================
  LISTAS CON COMA FINAL OPCIONAL
  ============================================================
*/

expr_list_opt
    : expr_list_maybe_trailing
        { $$ = $1; }
    |
        { $$ = []; }
    ;

expr_list_maybe_trailing
    : expr_list
        { $$ = $1; }
    | expr_list ','
        { $$ = $1; }
    ;

expr_list
    : expr_list ',' expression
        { $$ = $1.concat([$3]); }
    | expression
        { $$ = [$1]; }
    ;

struct_init_seq_opt
    : struct_init_list_maybe_trailing
        { $$ = $1; }
    |
        { $$ = []; }
    ;

struct_init_list_maybe_trailing
    : struct_init_list
        { $$ = $1; }
    | struct_init_list ','
        { $$ = $1; }
    ;

struct_init_list
    : struct_init_list ',' struct_init
        { $$ = $1.concat([$3]); }
    | struct_init
        { $$ = [$1]; }
    ;

slice_item_seq_opt
    : slice_item_list_maybe_trailing
        { $$ = $1; }
    |
        { $$ = []; }
    ;

slice_item_list_maybe_trailing
    : slice_item_list
        { $$ = $1; }
    | slice_item_list ','
        { $$ = $1; }
    ;

slice_item_list
    : slice_item_list ',' slice_item
        { $$ = $1.concat([$3]); }
    | slice_item
        { $$ = [$1]; }
    ;

/*
  ============================================================
  LLAMADAS Y LITERALES
  ============================================================
*/

call_expr
    : IDENTIFIER '(' expr_list_opt ')'
        {
          $$ = createNode('CallExpression', $1, @1, $3);
        }
    | STRCONV '.' IDENTIFIER '(' expr_list_opt ')'
        {
          $$ = createNode('QualifiedCallExpression', 'strconv.' + $3, @1, $5);
        }
    | STRINGS '.' IDENTIFIER '(' expr_list_opt ')'
        {
          $$ = createNode('QualifiedCallExpression', 'strings.' + $3, @1, $5);
        }
    | SLICES '.' IDENTIFIER '(' expr_list_opt ')'
        {
          $$ = createNode('QualifiedCallExpression', 'slices.' + $3, @1, $5);
        }
    | REFLECT '.' TYPEOF '(' expr_list_opt ')'
        {
          $$ = createNode('QualifiedCallExpression', 'reflect.TypeOf', @1, $5);
        }
    | REFLECT '.' TYPEOF '(' expr_list_opt ')' '.' TYPE_STRING '(' ')'
        {
          $$ = createNode('QualifiedCallExpression', 'reflect.TypeOf.string', @1, $5);
        }
    ;

array_literal
    : '[' INT ']' array_element_type '{' expr_list_opt '}'
        {
          var children = [$4].concat($6);
          $$ = createNode('ArrayLiteral', $2, @1, children);
        }
    ;

slice_literal
    : '[' ']' slice_element_type '{' slice_item_seq_opt '}'
        {
          var children = [$3].concat($5);
          $$ = createNode('SliceLiteral', null, @1, children);
        }
    ;

slice_item
    : expression
        { $$ = $1; }
    | anonymous_slice_literal
        { $$ = $1; }
    ;

anonymous_slice_literal
    : '{' slice_item_seq_opt '}'
        {
          $$ = createNode('AnonymousSliceLiteral', null, @1, $2);
        }
    ;

struct_literal
    : IDENTIFIER '{' struct_init_seq_opt '}'
        {
          $$ = createNode('StructLiteral', $1, @1, $3);
        }
    ;

struct_init
    : IDENTIFIER ':' expression
        {
          $$ = createNode('StructInit', $1, @1, [$3]);
        }
    ;

/*
  ============================================================
  PRIMARIAS Y POSTFIX
  ============================================================
*/

primary_expression
    : call_expr
        { $$ = $1; }
    | array_literal
        { $$ = $1; }
    | slice_literal
        { $$ = $1; }
    | struct_literal
        { $$ = $1; }
    | literal
        { $$ = $1; }
    | IDENTIFIER
        { $$ = createNode('Identifier', $1, @1, []); }
    | '(' expression ')'
        { $$ = $2; }
    ;

postfix_expression
    : primary_expression
        { $$ = $1; }
    | postfix_expression '[' expression ']'
        {
          $$ = createNode('ArrayAccess', null, @2, [$1, $3]);
        }
    | postfix_expression '.' IDENTIFIER
        {
          $$ = createNode('FieldAccess', $3, @2, [$1]);
        }
    ;

primary_expression_no_struct
    : call_expr
        { $$ = $1; }
    | array_literal
        { $$ = $1; }
    | slice_literal
        { $$ = $1; }
    | literal
        { $$ = $1; }
    | IDENTIFIER
        { $$ = createNode('Identifier', $1, @1, []); }
    | '(' expression ')'
        { $$ = $2; }
    ;

postfix_expression_no_struct
    : primary_expression_no_struct
        { $$ = $1; }
    | postfix_expression_no_struct '[' expression ']'
        {
          $$ = createNode('ArrayAccess', null, @2, [$1, $3]);
        }
    | postfix_expression_no_struct '.' IDENTIFIER
        {
          $$ = createNode('FieldAccess', $3, @2, [$1]);
        }
    ;

expression_no_struct
    : expression_no_struct OR expression_no_struct
        { $$ = createNode('BinaryExpression', '||', @2, [$1, $3]); }
    | expression_no_struct AND expression_no_struct
        { $$ = createNode('BinaryExpression', '&&', @2, [$1, $3]); }
    | expression_no_struct EQ expression_no_struct
        { $$ = createNode('BinaryExpression', '==', @2, [$1, $3]); }
    | expression_no_struct NEQ expression_no_struct
        { $$ = createNode('BinaryExpression', '!=', @2, [$1, $3]); }
    | expression_no_struct '>' expression_no_struct
        { $$ = createNode('BinaryExpression', '>', @2, [$1, $3]); }
    | expression_no_struct '<' expression_no_struct
        { $$ = createNode('BinaryExpression', '<', @2, [$1, $3]); }
    | expression_no_struct GTE expression_no_struct
        { $$ = createNode('BinaryExpression', '>=', @2, [$1, $3]); }
    | expression_no_struct LTE expression_no_struct
        { $$ = createNode('BinaryExpression', '<=', @2, [$1, $3]); }
    | expression_no_struct '+' expression_no_struct
        { $$ = createNode('BinaryExpression', '+', @2, [$1, $3]); }
    | expression_no_struct '-' expression_no_struct
        { $$ = createNode('BinaryExpression', '-', @2, [$1, $3]); }
    | expression_no_struct '*' expression_no_struct
        { $$ = createNode('BinaryExpression', '*', @2, [$1, $3]); }
    | expression_no_struct '/' expression_no_struct
        { $$ = createNode('BinaryExpression', '/', @2, [$1, $3]); }
    | expression_no_struct '%' expression_no_struct
        { $$ = createNode('BinaryExpression', '%', @2, [$1, $3]); }
    | NOT expression_no_struct %prec NOT
        { $$ = createNode('UnaryExpression', '!', @1, [$2]); }
    | '-' expression_no_struct %prec UMINUS
        { $$ = createNode('UnaryExpression', '-', @1, [$2]); }
    | postfix_expression_no_struct
        { $$ = $1; }
    ;

/*
  ============================================================
  EXPRESIONES
  ============================================================
*/

expression
    : expression OR expression
        { $$ = createNode('BinaryExpression', '||', @2, [$1, $3]); }
    | expression AND expression
        { $$ = createNode('BinaryExpression', '&&', @2, [$1, $3]); }
    | expression EQ expression
        { $$ = createNode('BinaryExpression', '==', @2, [$1, $3]); }
    | expression NEQ expression
        { $$ = createNode('BinaryExpression', '!=', @2, [$1, $3]); }
    | expression '>' expression
        { $$ = createNode('BinaryExpression', '>', @2, [$1, $3]); }
    | expression '<' expression
        { $$ = createNode('BinaryExpression', '<', @2, [$1, $3]); }
    | expression GTE expression
        { $$ = createNode('BinaryExpression', '>=', @2, [$1, $3]); }
    | expression LTE expression
        { $$ = createNode('BinaryExpression', '<=', @2, [$1, $3]); }
    | expression '+' expression
        { $$ = createNode('BinaryExpression', '+', @2, [$1, $3]); }
    | expression '-' expression
        { $$ = createNode('BinaryExpression', '-', @2, [$1, $3]); }
    | expression '*' expression
        { $$ = createNode('BinaryExpression', '*', @2, [$1, $3]); }
    | expression '/' expression
        { $$ = createNode('BinaryExpression', '/', @2, [$1, $3]); }
    | expression '%' expression
        { $$ = createNode('BinaryExpression', '%', @2, [$1, $3]); }
    | NOT expression %prec NOT
        { $$ = createNode('UnaryExpression', '!', @1, [$2]); }
    | '-' expression %prec UMINUS
        { $$ = createNode('UnaryExpression', '-', @1, [$2]); }
    | postfix_expression
        { $$ = $1; }
    ;

literal
    : INT
        { $$ = createNode('IntLiteral', $1, @1, []); }
    | FLOAT
        { $$ = createNode('FloatLiteral', $1, @1, []); }
    | STRING
        { $$ = createNode('StringLiteral', decodeString($1), @1, []); }
    | BOOL
        { $$ = createNode('BoolLiteral', $1, @1, []); }
    | RUNE
        { $$ = createNode('RuneLiteral', decodeRune($1), @1, []); }
    | NIL
        { $$ = createNode('NilLiteral', 'nil', @1, []); }
    ;