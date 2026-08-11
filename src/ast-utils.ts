import { Node } from 'ts-morph';

/**
 * Removes syntax-only wrappers that do not change the runtime value of an expression.
 * Keeping this centralized prevents individual detectors from silently missing
 * `as const`, `satisfies`, parenthesized, asserted, or non-null expressions.
 */
export function unwrapExpression(node: Node): Node {
  let current = node;
  while (true) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isTypeAssertion(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isNonNullExpression(current)
    ) {
      current = current.getExpression();
      continue;
    }
    return current;
  }
}

export function asObjectLiteral(node: Node | undefined): ReturnType<Node['asKind']> | undefined {
  if (!node) return undefined;
  const unwrapped = unwrapExpression(node);
  return Node.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
}

export function asArrayLiteral(node: Node | undefined): ReturnType<Node['asKind']> | undefined {
  if (!node) return undefined;
  const unwrapped = unwrapExpression(node);
  return Node.isArrayLiteralExpression(unwrapped) ? unwrapped : undefined;
}
