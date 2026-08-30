import { css } from 'ecij';

import { importedClass } from './scoping-helper';

// `importedClass` resolves through './scoping-helper', but the second
// interpolation cannot be resolved statically. The declaration is skipped and
// left untouched, so the helper's stylesheet must not be registered as a
// dependency of this module on its account.
export const skipped = css`
  &.${importedClass} {
    width: ${Math.random()}px;
  }
`;

export const extracted = css`
  color: red;
`;
