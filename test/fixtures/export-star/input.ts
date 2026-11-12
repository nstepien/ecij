import { css } from 'ecij';
// @ts-expect-error -- an external module, which is not installed
import { fromExternal } from 'external-tokens';

import * as barrel from './barrel';
import { fontSize, gap, redClass } from './barrel';

// The names of `export *` resolve, through nested `export *` too, values and class names alike
export const starClass = css`
  font-size: ${fontSize}px;
  gap: ${gap}px;

  &.${redClass} {
    color: ${
      // @ts-expect-error -- TypeScript takes the type that the barrel exports, which JS does not have
      barrel.color
    };
  }
`;

// The module's own exports take precedence
export const ownExportClass = css`
  font-weight: ${barrel.fontWeight};
`;

// Modules of `export *` can export the same binding, re-exported or not, namespaces included
export const sameBindingClass = css`
  margin: ${barrel.gap}px;
  border-color: ${barrel.tokens.color};
`;

// Even those without static values → NOT extracted
export const ownFunctionClass = css`
  width: ${barrel.width as unknown as number}px;
`;

export const ownDestructuredClass = css`
  background: ${barrel.bgColor};
`;

// Different bindings by the same name are ambiguous, even with the same value → NOT extracted
export const ambiguousClass = css`
  margin: ${barrel.spacing}px;
`;

// `export *` does not export `default` → NOT extracted
export const defaultClass = css`
  color: ${
    // @ts-expect-error -- not exported
    barrel.default
  };
`;

// Nor the names that only modules outside the build may export → NOT extracted
export const externalStarClass = css`
  color: ${
    // @ts-expect-error -- an external module, which is not installed
    barrel.fromExternal
  };
`;

// Nor the values that lead to them → NOT extracted
export const externalReexportClass = css`
  color: ${barrel.reexportedExternal};
`;

export const externalImportClass = css`
  color: ${fromExternal};
`;
