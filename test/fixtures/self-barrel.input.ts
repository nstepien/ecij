import { css } from 'ecij';

// Importing from a barrel that `export *`s this very file — resolution must
// not deadlock trying to load the module that is currently being transformed.
import { tokenColor } from './self-barrel';

export const selfBarrelClass = css`
  /* self-barrel */
  color: ${tokenColor};
`;
