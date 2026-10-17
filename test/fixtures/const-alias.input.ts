import { css } from 'ecij';

import { aliasedClass, aliasedColor } from './const-alias-helper';

const red = 'red';

// A `const` bound to another `const` takes its value
const danger = red;

export const aliasedValueClass = css`
  color: ${danger};
`;

// Class names included
const base = css`
  display: flex;
`;
const layout = base;

export const aliasedClassNameClass = css`
  &.${layout} {
    gap: 4px;
  }
`;

// The aliased binding is looked up where the alias is declared, following
// lexical scoping: it may shadow an outer binding, or be declared later
export function scopedAliases() {
  const red = 'darkred';
  const shade = red;
  // `accent` is itself an alias, declared after this function
  const textColor = accent;

  return css`
    color: ${shade};
    border-color: ${textColor};
  `;
}

const brand = 'blue';
const accent = brand;

// Exported aliases resolve in the modules importing them
export const importedAliasesClass = css`
  color: ${aliasedColor};

  &.${aliasedClass} {
    color: ${red};
  }
`;

// An alias of a `let` or of an import does not resolve → NOT extracted
export function unresolvedAliases() {
  let mutable = 'blue';
  const fromLet = mutable;
  const fromImport = aliasedColor;

  return [
    css`
      color: ${fromLet};
    `,
    css`
      color: ${fromImport};
    `,
  ];
}

// Neither does a cycle → NOT extracted
export function cyclicAliases() {
  // @ts-expect-error -- used before its declaration (TDZ at runtime)
  const first: string = second;
  const second: string = first;

  return css`
    color: ${second};
  `;
}
