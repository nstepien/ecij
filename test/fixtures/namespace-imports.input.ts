import { css } from 'ecij';

import * as helper from './import-forms-helper';
import * as style from './imported-style';
import * as nested from './namespace-imports-helper';
import { literals } from './namespace-imports-helper';

// Members are the exports of the module, values and class names alike
export const memberClass = css`
  width: ${style.width}px;
  background: ${style.bgColor};

  &.${style.redClass} {
    color: inherit;
  }
`;

// Namespace imports exported again are namespaces too, as members or imported by name
export const exportedNamespaceClass = css`
  font-size: ${nested.literals.fontSize}px;
  font-weight: ${literals.fontWeight};
`;

// `const` bindings of namespaces and of their members resolve too
const aliasedStyle = style;
const aliasedWidth = style.width;

export const aliasedNamespaceClass = css`
  max-width: ${aliasedWidth}px;

  &.${aliasedStyle.redClass} {
    width: auto;
  }
`;

// Members re-exported from other modules do not → NOT extracted
export const reexportedMemberClass = css`
  font-weight: ${helper.reexported};
`;

// Namespaces are not strings → NOT extracted
export const namespaceValueClass = css`
  color: ${style as unknown as string};
`;

// Only namespaces have members, not strings → NOT extracted
export const valueMemberClass = css`
  width: ${style.bgColor.length}px;
`;

// Nor other objects → NOT extracted
const theme = { color: 'teal' };

export const objectMemberClass = css`
  color: ${theme.color};
`;

// Computed members are not resolved → NOT extracted
export const computedMemberClass = css`
  color: ${style['bgColor']};
`;

// A local binding shadows the namespace import → NOT extracted
export function shadowedNamespace(style: { width: number }) {
  return css`
    width: ${style.width}px;
  `;
}
