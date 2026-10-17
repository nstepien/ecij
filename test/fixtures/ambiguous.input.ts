// @ts-nocheck — `accent` is ambiguous, so the namespaces expose no such member
import { css } from 'ecij';

import * as ambiguous from './ambiguous-barrel';
import * as outer from './ambiguous-outer';

// At runtime `ambiguous.accent` is undefined (ambiguous star exports are
// excluded from namespace objects) — the plugin must warn, not pick one.
export const usesAmbiguous = css`
  color: ${ambiguous.accent};
`;

// The barrel's ambiguous `accent` and the alias's value stem from the same
// binding name; the ambiguity must still win over the value.
export const usesNestedAmbiguous = css`
  color: ${outer.accent};
`;
