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
%token EQ NEQ GTE LTE AND OR NOT IF ELSE FOR INC DEC BREAK CONTINUE RETURN
%token SWITCH CASE DEFAULT

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
"fmt"                                           return 'FMT';
"Println"                                       return 'PRINTLN';
"if"                                            return 'IF';
"else"                                          return 'ELSE';
"for"                                           return 'FOR';
"break"                                         return 'BREAK';
"continue"                                      return 'CONTINUE';
"return"                                        return 'RETURN';
"switch"                                        return 'SWITCH';
"case"                                          return 'CASE';
"default"                                       return 'DEFAULT';

"int"                                           return 'TYPE_INT';
"float64"                                       return 'TYPE_FLOAT64';
"string"                                        return 'TYPE_STRING';
"bool"                                          return 'TYPE_BOOL';
"rune"                                          return 'TYPE_RUNE';

"true"|"false"                                  return 'BOOL';

":="                                            return 'DECLARE';
"=="                                            return 'EQ';
"!="                                            return 'NEQ';
">="                                            return 'GTE';
"<="                                            return 'LTE';
"&&"                                            return 'AND';
"||"                                            return 'OR';
"++"                                            return 'INC';
"--"                                            return 'DEC';
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
    : IDENTIFIER type_spec
        {
          $$ = createNode('Parameter', null, @1, [
            createNode('Identifier', $1, @1, []),
            $2
          ]);
        }
    ;

return_type_opt
    : type_spec
        { $$ = createNode('ReturnType', $1.value, @1, []); }
    |
        { $$ = createNode('ReturnType', 'void', null, []); }
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
    | expr_stmt
        { $$ = $1; }
    | var_decl
        { $$ = $1; }
    | short_decl
        { $$ = $1; }
    | assignment
        { $$ = $1; }
    | if_stmt
        { $$ = $1; }
    | for_stmt
        { $$ = $1; }
    | switch_stmt
        { $$ = $1; }
    | inc_stmt
        { $$ = $1; }
    | dec_stmt
        { $$ = $1; }
    | break_stmt
        { $$ = $1; }
    | continue_stmt
        { $$ = $1; }
    | return_stmt
        { $$ = $1; }
    ;

println_stmt
    : FMT '.' PRINTLN '(' expr_list_opt ')'
        { $$ = createNode('PrintlnStatement', null, @1, $5); }
    ;

expr_stmt
    : call_expr
        { $$ = createNode('ExpressionStatement', null, @1, [$1]); }
    ;

if_stmt
    : IF expression block else_part_opt
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

for_stmt
    : FOR expression block
        {
          $$ = createNode('ForStatement', 'condition', @1, [$2, $3]);
        }
    | FOR for_init_opt ';' for_condition_opt ';' for_update_opt block
        {
          var initNode = $2 ? $2 : createNode('Empty', null, @1, []);
          var conditionNode = $4 ? $4 : createNode('Empty', null, @1, []);
          var updateNode = $6 ? $6 : createNode('Empty', null, @1, []);
          $$ = createNode('ForStatement', 'classic', @1, [
            initNode,
            conditionNode,
            updateNode,
            $7
          ]);
        }
    ;

switch_stmt
    : SWITCH expression '{' case_clause_list_opt default_clause_opt '}'
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

for_init_opt
    : var_decl
        { $$ = $1; }
    | short_decl
        { $$ = $1; }
    | assignment
        { $$ = $1; }
    |
        { $$ = null; }
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

call_expr
    : IDENTIFIER '(' expr_list_opt ')'
        {
          $$ = createNode('CallExpression', $1, @1, $3);
        }
    ;

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
    | '(' expression ')'
        { $$ = $2; }
    | call_expr
        { $$ = $1; }
    | literal
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