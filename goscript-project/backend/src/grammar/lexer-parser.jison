%{
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
%}

%locations

%token FUNC VAR FMT PRINTLN TYPE_INT TYPE_FLOAT64 TYPE_STRING TYPE_BOOL TYPE_RUNE
%token IDENTIFIER STRING INT FLOAT BOOL RUNE DECLARE EOF

%start program

%lex
%options flex

%%
[ \t\r\n]+                                      /* ignorar espacios */
"//"[^\n]*                                      /* comentario una línea */

"func"                                          return 'FUNC';
"var"                                           return 'VAR';
"fmt"                                           return 'FMT';
"Println"                                       return 'PRINTLN';

"int"                                           return 'TYPE_INT';
"float64"                                       return 'TYPE_FLOAT64';
"string"                                        return 'TYPE_STRING';
"bool"                                          return 'TYPE_BOOL';
"rune"                                          return 'TYPE_RUNE';

"true"|"false"                                  return 'BOOL';

":="                                            return 'DECLARE';
"="                                             return '=';
","                                             return ',';
";"                                             return ';';
"."                                             return '.';
"("                                             return '(';
")"                                             return ')';
"{"                                             return '{';
"}"                                             return '}';

[0-9]+\.[0-9]+                                  return 'FLOAT';
[0-9]+                                          return 'INT';

\"([^\\"]|\\["\\nrt])*\"                        return 'STRING';
\'([^\\']|\\[nrt\\'"\\])*\'                     return 'RUNE';

[a-zA-Z_][a-zA-Z0-9_]*                          return 'IDENTIFIER';

<<EOF>>                                         return 'EOF';

. {
  throw {
    type: 'Lexico',
    description: 'El símbolo "' + yytext + '" no es aceptado en el lenguaje.',
    line: yylloc.first_line || 1,
    column: (yylloc.first_column || 0) + 1
  };
}
/lex

%%

program
    : function_list EOF
        {
          yy.shared = yy.shared || {};
          yy.shared.ast = createNode('Program', null, @1, $1);
          $$ = yy.shared.ast;
        }
    ;

function_list
    : function_list function_decl
        { $$ = $1.concat([$2]); }
    | function_decl
        { $$ = [$1]; }
    ;

function_decl
    : FUNC IDENTIFIER '(' ')' block
        { $$ = createNode('FunctionDeclaration', $2, @2, [$5]); }
    ;

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
    | short_decl
        { $$ = $1; }
    | assignment
        { $$ = $1; }
    ;

println_stmt
    : FMT '.' PRINTLN '(' expr_list_opt ')'
        { $$ = createNode('PrintlnStatement', null, @1, $5); }
    ;

var_decl
    : VAR IDENTIFIER type_spec '=' expression
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $3,
            $5
          ]);
        }
    | VAR IDENTIFIER type_spec
        {
          $$ = createNode('VarDeclaration', null, @1, [
            createNode('Identifier', $2, @2, []),
            $3
          ]);
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
    : IDENTIFIER '=' expression
        {
          $$ = createNode('Assignment', null, @1, [
            createNode('Identifier', $1, @1, []),
            $3
          ]);
        }
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

expr_list_opt
    : expr_list
        { $$ = $1; }
    |
        { $$ = []; }
    ;

expr_list
    : expr_list ',' expression
        { $$ = $1.concat([$3]); }
    | expression
        { $$ = [$1]; }
    ;

expression
    : literal
        { $$ = $1; }
    | IDENTIFIER
        { $$ = createNode('Identifier', $1, @1, []); }
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
    ;