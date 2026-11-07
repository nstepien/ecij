import { css } from 'ecij';

// Default-exported css tagged template behind a TS `as` assertion — the
// wrapper (like parentheses) must be unwrapped for the declaration to be
// recognized.
export default css`
  /* wrapped-default */
  display: flex;
` as string;
