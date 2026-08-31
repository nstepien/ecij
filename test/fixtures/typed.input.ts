// @ts-nocheck — enums and namespaces are not erasable syntax (tsconfig), and
// the plugin must see them raw
import { css } from 'ecij';

// A `.js` module that Rolldown is told to treat as JSX (`moduleTypes`)
import { jsxClass } from './jsx-tokens.js';
// Inline type modifier mixed with a value import
import { type LocalSpec, typedTone } from './typed-barrel';
// Statement-level type-only import — erased
import type { ToneType } from './typed-tokens';
// Namespace type-only import — erased
import type * as TypedNs from './typed-tokens';

const toneAnnotation: ToneType = 'plum';
const spec: LocalSpec = '12px';
const nsAnnotated: TypedNs.ToneType = 'navy';

export const usesTypedTone = css`
  /* uses typed-tone */
  color: ${typedTone};
  outline-color: ${toneAnnotation};
  width: ${spec};
  border-color: ${nsAnnotated};
`;

// A type-asserted assignment target only reaches the plugin as such here:
// Vite strips the assertion before its transforms run. The binding is
// reassigned, so it has no static value.
let asserted = 'olive';
(asserted as string) = 'lime';

export const usesAssertedTarget = css`
  color: ${asserted};
`;

// TypeScript enums and namespaces only reach the plugin as such here (Vite
// lowers them first). An enum shadows the outer binding of the same name…
export function enumShadow() {
  enum toneAnnotation {
    A = 'x',
  }
  return css`
    color: ${toneAnnotation as unknown as string};
  `;
}

// …and a namespace's members are scoped to it: `spec` below is still '12px'.
namespace Local {
  export const spec = 'wrong';
}
console.log(Local.spec);

export const usesSpecAfterNamespace = css`
  width: ${spec};
`;

export const usesJsxClass = css`
  &.${jsxClass} {
    color: red;
  }
`;
