import { css } from 'ecij';

import * as literals from './imported-literals';
import { border, color, gap, width } from './wrapped-values';

declare const unknownValue: string;

// Parentheses and type assertions keep the value they wrap, in this module and in the modules it
// imports from
export const wrappedClass = css`
  margin: ${gap as number}px ${gap satisfies number}px ${gap!}px;
  padding: ${-(gap as number)}px;
  color: ${(color as string)!};
  width: ${width}px;
  border: ${border};
  font-size: ${(literals as typeof literals).fontSize}px;
`;

// The warning names the wrapped reference → NOT extracted
export const wrappedUnresolvedClass = css`
  color: ${(unknownValue as string)!};
`;
