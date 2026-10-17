// @ts-expect-error -- '@acme/tokens' deliberately does not exist, see external-barrel.ts
import { brandColor as externalBrand } from '@acme/tokens';
import { css } from 'ecij';

import { brandColor, externalAccent } from './external-barrel';

export const usesExternalBarrel = css`
  /* uses external-barrel */
  color: ${brandColor};
`;

// External modules are not loaded, whether imported directly or re-exported by name
export const usesExternalImport = css`
  color: ${externalBrand};
`;

export const usesExternalReexport = css`
  color: ${externalAccent};
`;
