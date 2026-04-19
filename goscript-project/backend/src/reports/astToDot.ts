import type { AstNode } from "../ast/AstNode";

function escapeDot(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

export function astToDot(root: AstNode | null): string {
  if (!root) {
    return "digraph AST {\n}";
  }

  let counter = 0;
  const lines: string[] = [
    "digraph AST {",
    "  node [shape=box];"
  ];

  function walk(node: AstNode): string {
    const id = `n${counter++}`;

    const labelParts = [node.kind];

    if (node.value) {
      labelParts.push(node.value);
    }

    labelParts.push(`(${node.line},${node.column})`);

    lines.push(`  ${id} [label="${escapeDot(labelParts.join("\n"))}"];`);

    for (const child of node.children) {
      const childId = walk(child);
      lines.push(`  ${id} -> ${childId};`);
    }

    return id;
  }

  walk(root);
  lines.push("}");

  return lines.join("\n");
}