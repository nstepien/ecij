import { css } from 'ecij';

// Default import re-exported under its local name (`import d from 'mod'; export { d };`)
import { passthroughDefault } from './default-passthrough';
// Default export of a binding declared later: `undefined` when the statement runs
import forwardDefault from './export-default-forward';
// Default exports with static expressions the evaluator must unwrap
import negativePad from './export-default-negative';
import wrappedClass from './export-default-wrapped-css';
// Namespace re-export reached through a chained named re-export
import { styles as chainedStyles } from './ns-chain';
// Namespace re-export reached through an `export *` aggregation
import { styles as starChainedStyles } from './ns-chain-star';
// Nested namespace member access (`ns.inner.member`)
import * as outerNs from './reexports-namespace';

export const usesPassthroughDefault = css`
  /* uses passthrough-default */
  color: ${passthroughDefault};
`;

export const usesChainedNamespace = css`
  /* uses chained-namespace */
  color: ${chainedStyles.accentColor};
`;

export const usesStarChainedNamespace = css`
  /* uses star-chained-namespace */
  font-size: ${starChainedStyles.accentSize}px;
`;

export const usesNestedNamespaceMember = css`
  /* uses nested-namespace-member */
  background: ${outerNs.styles.accentColor};

  &.${outerNs.styles.accentClass} {
    color: red;
  }
`;

export const usesNegativeDefault = css`
  /* uses negative-default */
  margin: ${negativePad}px;
`;

export const usesWrappedDefaultCss = css`
  /* uses wrapped-default-css */
  &.${wrappedClass} {
    color: red;
  }
`;

export const usesForwardDefault = css`
  /* uses forward-default */
  color: ${forwardDefault};
`;
