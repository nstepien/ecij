import { css } from 'ecij';

// Default import — resolves to a css class created in another module
import defaultCssClass from './export-default-css';
// Default import — resolves to a string literal
import defaultColor from './export-default-literal';
// Default import — resolves to a locally-bound css class via `export default <local>`
import defaultLocalClass from './export-default-local';
// Namespace import — resolves members through the imported module's exports
import * as namedStyles from './named-styles';
// Re-export: named-as-named (passes through unchanged or renamed)
import { accentColor as reexportColor, renamedAccentClass } from './reexports-named';
// Re-export: default-as-named
import { defaultStyle } from './reexports-named';
// Re-export: named-as-default
import reexportDefault from './reexports-named';
// Namespace re-export accessed through a named import
import { styles } from './reexports-namespace';
// `export * from 'mod'` — looks up via star aggregation (excludes default)
import { accentColor as starAccentColor, accentClass as starAccentClass } from './reexports-star';
// Inline type modifier mixed with a value import; `typedTone` resolves through
// the barrel's `export *` despite the barrel's type-only re-exports of a decoy
import { type LocalSpec, typedTone } from './typed-barrel';
// Type-only imports — erased at runtime and ignored by the plugin
import type { ToneType } from './typed-tokens';

export const usesDefaultCssClass = css`
  /* uses default-css */
  &.${defaultCssClass} {
    color: red;
  }
`;

export const usesDefaultLiteral = css`
  /* uses default-literal */
  color: ${defaultColor};
`;

export const usesDefaultLocalClass = css`
  /* uses default-local */
  &.${defaultLocalClass} {
    border: 1px solid;
  }
`;

export const usesNamespaceImport = css`
  /* uses namespace */
  background: ${namedStyles.accentColor};
  font-size: ${namedStyles.accentSize}px;

  &.${namedStyles.accentClass} {
    color: red;
  }
`;

export const usesReexportNamed = css`
  /* uses reexport-named */
  color: ${reexportColor};

  &.${renamedAccentClass} {
    color: red;
  }
`;

export const usesReexportDefaultAsNamed = css`
  /* uses reexport-default-as-named */
  &.${defaultStyle} {
    color: red;
  }
`;

export const usesReexportNamedAsDefault = css`
  /* uses reexport-named-as-default */
  color: ${reexportDefault};
`;

export const usesStarReexport = css`
  /* uses star-reexport */
  color: ${starAccentColor};

  &.${starAccentClass} {
    color: red;
  }
`;

export const usesNamespaceReexport = css`
  /* uses namespace-reexport */
  background: ${styles.accentColor};

  &.${styles.accentClass} {
    color: red;
  }
`;

// `export default css\`...\`` from the entry file itself
export default css`
  /* entry-default */
  font-size: 12px;
`;

const typedOutline: ToneType = 'peru';
const typedWidth: LocalSpec = '6px';

export const usesTypeOnlyBarrel = css`
  /* uses type-only-barrel */
  color: ${typedTone};
  outline-color: ${typedOutline};
  width: ${typedWidth};
`;
