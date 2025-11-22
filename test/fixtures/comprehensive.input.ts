import { css } from 'ecij';
import { bgColor as background, redClass, width } from './imported-style';
import { fontSize, fontWeight } from './imported-literals';

// Basic CSS transformation
export const buttonClass = css`
  /* button */
  border: 1px solid blue;
  padding: 10px;
`;

// Multiple declarations
export const primaryClass = css`
  /* primary */
  color: blue;
`;

export const secondaryClass = css`
  /* secondary */
  color: green;
`;

// empty CSS blocks do not produce any CSS output
const emptyClass = css``;

// Local variable interpolation
const baseColor = 'red';

const highlightedClass = css`
  /* highlighted */
  color: ${baseColor};

  &.${emptyClass} {
    font-weight: bold;
  }
`;

// Imported variable and class name interpolation
export const importedClass = css`
  /* imported */
  background: ${background};
  width: ${width}px;
  font-size: ${fontSize}px;
  font-weight: ${fontWeight};

  &.${redClass} {
    border-color: red;
  }
`;

// Nested local interpolation
export const nestedClass = css`
  /* nested */
  background: gray;

  &.${highlightedClass} {
    color: ${baseColor};
  }
`;

// Inline CSS (not assigned to variable)
export function getButtonClass() {
  return css`
    /* inline css */
    background: blue;
    padding: 8px 16px;
  `;
}
