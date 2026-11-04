import { css } from 'ecij';

export const buttonClass = css`
  color: red;
`;

export function Button() {
  return <button className={buttonClass} />;
}
