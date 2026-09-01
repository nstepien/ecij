import { css } from 'ecij';

// Resolving `dColor` probes barrel-a and barrel-b (which fail to provide it)
// before the nested barrel — their stylesheets must NOT be dragged into this
// bundle, since nothing from them is used here.
import { dColor } from './barrel';

export const usesOnlyDeep = css`
  /* uses-only-deep */
  color: ${dColor};
`;
