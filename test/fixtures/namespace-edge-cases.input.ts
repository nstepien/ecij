// @ts-nocheck — this fixture deliberately uses a namespace import as a scalar
// and accesses a non-existent namespace member to validate the plugin's
// UNRESOLVED_INTERPOLATION warnings.
import { css } from 'ecij';

import * as namedStyles from './named-styles';
import { styles } from './reexports-namespace';
import * as starOnly from './star-over-default';

// `${ns.unknownMember}` — namespace exists, but the member does not.
// Should emit an UNRESOLVED_INTERPOLATION warning naming `ns.member`.
export const missingMember = css`
  color: ${namedStyles.unknownMember};
`;

// `${ns}` — using a namespace import as a scalar value is meaningless and
// should fall through to the standard UNRESOLVED_INTERPOLATION warning.
export const namespaceAsScalar = css`
  color: ${namedStyles};
`;

// `${reexportedNs}` — same thing but for a namespace reached via
// `export * as ns from 'mod'` and then imported by name.
export const namespaceReexportAsScalar = css`
  color: ${styles};
`;

// `export * from 'mod'` never forwards `default` — `starOnly.default` must
// warn instead of resolving the source module's default export ('royalblue').
export const starDefaultAsScalar = css`
  color: ${starOnly.default};
`;
