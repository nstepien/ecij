import { css } from 'ecij';

// Importing from a barrel that `export *`s this very file — resolution must
// not deadlock trying to load the module that is currently being transformed.
import { selfBarrelClass as viaBarrel, tokenColor } from './self-barrel';

// This module's own class, reached back through the barrel and declared
// later: resolved once its declaration is extracted, like a direct same-file
// forward reference.
export const usesOwnClassViaBarrel = css`
  &.${viaBarrel} {
    color: red;
  }
`;

export const selfBarrelClass = css`
  /* self-barrel */
  color: ${tokenColor};
`;
