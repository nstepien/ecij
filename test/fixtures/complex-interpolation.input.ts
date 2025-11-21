import { css } from 'ecij';

// This has a complex expression (ternary) that cannot be resolved statically
export const dynamicClass = css`
  color: ${Math.random() > 0.5 ? 'red' : 'blue'};
  padding: 10px;
`;

// This has an identifier that cannot be resolved statically
export const unresolvedIdentifierClass = css`
  color: ${
    // @ts-expect-error
    unknownVariable
  };
`;
