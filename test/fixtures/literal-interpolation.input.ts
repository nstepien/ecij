import { css } from 'ecij';

import { fontSize, fontWeight } from './imported-literals';

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

// Signed numbers resolve through const bindings too
const negativeOffset = -5;
export const signedConstClass = css`
  margin: ${negativeOffset}px;
`;

// Signs apply to any value that resolves to a number, which they convert like JS does
const gap = 4;
export const signedValueClass = css`
  margin: ${-gap}px ${-negativeOffset}px;
  top: ${-fontSize}px;
  opacity: ${+'0.50'};
`;

// Signs on values that are not numbers do not resolve → NOT extracted
export const signedStringClass = css`
  margin: ${-baseColor}px;
`;

// Nor do other unary operators → NOT extracted
export const bitwiseNotClass = css`
  margin: ${~gap}px;
`;

// Big integer literals, signed too
export const bigIntClass = css`
  z-index: ${10n};
  order: ${-1n};
`;

// `+` throws on big integers → NOT extracted
// @ts-expect-error -- TypeScript rejects it too
const plusBigInt = +1n;
export const plusBigIntClass = css`
  order: ${plusBigInt};
`;

// Template literals, once their interpolations resolve
const border = `${gap}px solid ${baseColor}`;
export const templateLiteralClass = css`
  color: ${`blue`};
  border: ${border};
  font: ${`${fontWeight} ${fontSize}px serif`};
`;

// Template literals with interpolations that do not resolve → NOT extracted
export const unresolvedTemplateLiteralClass = css`
  margin: ${`${true}px`};
`;

// Boolean literal is still rejected
export const booleanLiteralClass = css`
  color: ${true as unknown as string};
`;
