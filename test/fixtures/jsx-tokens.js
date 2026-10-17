import { css } from 'ecij';

// Declared as JSX through Rolldown's `moduleTypes`; the plugin must parse it
// as such instead of inferring plain JavaScript from the extension.
export const jsxClass = css`
  /* jsx */
  color: rebeccapurple;
`;

export function Button() {
  return <div className={jsxClass} />;
}
