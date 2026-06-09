// @ts-nocheck — `accent` is ambiguous, so the namespace exposes no such member
import { css } from 'ecij';

import * as ambiguous from './ambiguous-barrel';

// At runtime `ambiguous.accent` is undefined (ambiguous star exports are
// excluded from namespace objects) — the plugin must warn, not pick one.
export const usesAmbiguous = css`
  color: ${ambiguous.accent};
`;
