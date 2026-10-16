import { css } from 'ecij';

import { aClass } from './cycle-a';

export const bClass: string = css`
  .${aClass} {
    color: blue;
  }
`;
