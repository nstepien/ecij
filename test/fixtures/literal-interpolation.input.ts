import { css } from 'ecij';

// Inline string literal
export const stringLiteralClass = css`
  color: ${'blue'};
`;

// Inline number literal
export const numberLiteralClass = css`
  width: ${42}px;
  opacity: ${0.5};
`;

// Mixed inline literals and identifiers
const baseColor = 'red';
export const mixedClass = css`
  color: ${baseColor};
  font-size: ${16}px;
  background: ${'white'};
`;

// Negative number literal (UnaryExpression over numeric Literal)
export const negativeNumberClass = css`
  margin: ${-5}px;
  letter-spacing: ${-0.25}em;
`;

// Unary plus is also accepted (numerically equivalent)
export const unaryPlusClass = css`
  width: ${+10}px;
`;

// Boolean literal is still rejected
export const booleanLiteralClass = css`
  color: ${true as unknown as string};
`;
