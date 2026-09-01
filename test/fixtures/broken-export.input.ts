import { css } from 'ecij';

import { brokenClass } from './broken-export';

export const usesBrokenClass = css`
  &.${brokenClass} {
    color: red;
  }
`;
