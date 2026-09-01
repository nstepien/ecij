import { css } from 'ecij';

function dynamicPadding(): number {
  return 4;
}

// Extraction of this declaration fails (complex interpolation), so its class
// name must not leak into consumers as if its rule existed.
export const brokenClass = css`
  padding: ${dynamicPadding()}px;
`;
