// ==========================================
// AST Node Types
// ==========================================

export type ASTNode =
  | { type: "column"; name: string }
  | { type: "function"; name: string; args: ASTNode[] }
  | { type: "operator"; op: string; left: ASTNode; right: ASTNode }
  | { type: "literal"; value: any };

/** Wraps raw JS values into AST literal nodes; passes through existing AST nodes. */
export const wrapNode = (val: any): ASTNode =>
  val !== null && typeof val === "object" && "type" in val
    ? val
    : { type: "literal", value: val };

// ==========================================
// AST Compiler → SQL + Params
// ==========================================

const quoteName = (name: string): string => {
  if (typeof name !== "string" || name.length === 0)
    throw new Error("SQL identifier must be a non-empty string");
  return `"${name.replace(/"/g, '""')}"`;
};
const AST_OPERATORS = new Set(["=", "!=", ">", ">=", "<", "<=", "AND", "OR", "LIKE", "IS", "IS NOT", "NOT"]);

export function compileAST(node: ASTNode): { sql: string; params: any[] } {
  if (node.type === "column") return { sql: quoteName(node.name), params: [] };
  if (node.type === "literal") {
    if (node.value instanceof Date)
      return { sql: "?", params: [node.value.toISOString()] };
    if (typeof node.value === "boolean")
      return { sql: "?", params: [node.value ? 1 : 0] };
    return { sql: "?", params: [node.value] };
  }

  if (node.type === "function") {
    if (node.name === "IN") {
      if (node.args.length === 0) throw new Error("IN requires a left operand");
      const [leftNode, ...valueNodes] = node.args;
      const left = compileAST(leftNode!);
      const values = valueNodes.map(compileAST);
      if (values.length === 0) return { sql: "1 = 0", params: [] };
      return {
        sql: `${left.sql} IN (${values.map((v) => v.sql).join(", ")})`,
        params: [...left.params, ...values.flatMap((v) => v.params)],
      };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name))
      throw new Error(`Invalid SQL function name: ${JSON.stringify(node.name)}`);
    const compiledArgs = node.args.map(compileAST);
    return {
      // Validated above as a plain identifier, so it is safe unquoted.
      sql: `${node.name}(${compiledArgs.map((c) => c.sql).join(", ")})`,
      params: compiledArgs.flatMap((c) => c.params),
    };
  }

  if (node.type === "operator") {
    if (!AST_OPERATORS.has(node.op))
      throw new Error(`Unsupported AST SQL operator: ${node.op}`);
    const left = compileAST(node.left);
    const right = compileAST(node.right);
    return {
      sql: `(${left.sql} ${node.op} ${right.sql})`,
      params: [...left.params, ...right.params],
    };
  }

  throw new Error("Unknown AST node type");
}

// ==========================================
// Proxy Factories (Column, Function, Operator)
// ==========================================

/** Column proxy: c.name => { type: 'column', name: 'name' } */
export const createColumnProxy = <T>(): TypedColumnProxy<T> =>
  new Proxy({} as any, {
    get: (_, prop: string) => ({ type: "column", name: prop }) as ASTNode,
  });

/** Function proxy: f.lower(c.name) => { type: 'function', name: 'LOWER', args: [...] } */
export const createFunctionProxy = (): FunctionProxy =>
  new Proxy({} as any, {
    get:
      (_, funcName: string) =>
      (...args: any[]) =>
        ({
          type: "function",
          name: funcName.toUpperCase(),
          args: args.map(wrapNode),
        }) as ASTNode,
  });

/** Standard SQL operators as composable AST builders. */
export const op = {
  eq: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "=",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  ne: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "!=",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  gt: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: ">",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  gte: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: ">=",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  lt: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "<",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  lte: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "<=",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  and: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "AND",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  or: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "OR",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  like: (left: any, right: any): ASTNode => ({
    type: "operator",
    op: "LIKE",
    left: wrapNode(left),
    right: wrapNode(right),
  }),
  isNull: (node: any): ASTNode => ({
    type: "operator",
    op: "IS",
    left: wrapNode(node),
    right: { type: "literal", value: null } as ASTNode,
  }),
  isNotNull: (node: any): ASTNode => ({
    type: "operator",
    op: "IS NOT",
    left: wrapNode(node),
    right: { type: "literal", value: null } as ASTNode,
  }),
  in: (left: any, values: any[]): ASTNode => ({
    type: "function",
    name: "IN",
    args: [wrapNode(left), ...values.map((v) => wrapNode(v))],
  }),
  not: (node: any): ASTNode => ({
    type: "operator",
    op: "NOT",
    left: { type: "literal", value: "" } as ASTNode,
    right: wrapNode(node),
  }),
};

// ==========================================
// Type Definitions for IDE Autocomplete
// ==========================================

/** Maps schema fields to AST column nodes for typed autocomplete. */
export type TypedColumnProxy<T> = { [K in keyof T]: ASTNode };

/** SQL function proxy — any function name produces an AST function node. */
export type FunctionProxy = Record<string, (...args: any[]) => ASTNode>;

/** The operators object type. */
export type Operators = typeof op;

/** Callback signature for WHERE clauses. */
export type WhereCallback<T> = (
  c: TypedColumnProxy<T>,
  f: FunctionProxy,
  op: Operators,
) => ASTNode;

/** Callback signature for SET clauses in updates. */
export type SetCallback<T> = (
  c: TypedColumnProxy<T>,
  f: FunctionProxy,
) => Partial<Record<keyof T, any>>;
