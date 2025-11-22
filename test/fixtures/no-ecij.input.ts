// File without any ecij usage
import { css, unrelated } from './fake';

// ignore unrelated tagged template literals
export const unknown = unrelated`this is not css`;

// Ignore non-ecij css tag functions
export const buttonClass = css`
  color: blue;
  padding: 10px;
`;

export function getButtonClass() {
  return css`
    background: green;
    padding: 8px 16px;
  `;
}
