import { css } from 'ecij';

// This has a complex expression (ternary) that cannot be resolved statically
export const dynamicClass = css`
  color: ${Math.random() > 0.5 ? 'red' : 'blue'};
  padding: 10px;
`;

// Nor can a signed complex expression
export const signedDynamicClass = css`
  margin: ${-Math.random()}px;
`;

declare global {
  const unknownVariable: string;
}

// This has an identifier that cannot be resolved statically
export const unresolvedIdentifierClass = css`
  color: ${unknownVariable};
`;

// Nor can a signed identifier, which the warning names with its sign
export const signedUnresolvedIdentifierClass = css`
  margin: ${-unknownVariable}px;
`;
