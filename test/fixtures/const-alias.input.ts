import { css } from 'ecij';

import { aliasedClass, aliasedColor, aliasedWeight } from './const-alias-helper';

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

// Imports resolve too, and exported aliases resolve in the module declaring
// them: of a literal, of a class name, and of an import
const card = aliasedClass;

export const importedAliasesClass = css`
  color: ${aliasedColor};
  font-weight: ${aliasedWeight};

  &.${card} {
    color: ${red};
  }
`;

// An alias of a `let` does not resolve → NOT extracted
export function unresolvedAlias() {
  let mutable = 'blue';
  const fromLet = mutable;

  return css`
    color: ${fromLet};
  `;
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
