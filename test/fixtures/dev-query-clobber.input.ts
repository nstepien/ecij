import { css } from 'ecij';

import defaultClass from './export-default-css';

// Served after `export-default-css.ts?raw` was transformed: that query variant
// must not have replaced the module's cached parse info with its own
// `export default "<source text>"`.
export const usesDefaultAfterRaw = css`
  &.${defaultClass} {
    color: blue;
  }
`;
