// @ts-nocheck — the forward reference below is deliberate (it is valid once
// the plugin replaces both templates with class-name strings).
import { css } from 'ecij';

function dynamicPad(): number {
  return 4;
}

const forwardColor = 'green';

// References a class declared *later* in the file — must still resolve.
export const usesForward = css`
  &.${forwardClass} {
    color: red;
  }
`;

export const forwardClass = css`
  /* forward */
  color: ${forwardColor};
`;

// Extraction of this declaration fails (complex interpolation)...
const brokenSameFile = css`
  padding: ${dynamicPad()}px;
`;

// ...so its class name must not leak into this same-file consumer either.
export const usesBrokenSameFile = css`
  &.${brokenSameFile} {
    color: red;
  }
`;
