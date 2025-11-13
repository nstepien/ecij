/**
 * @example
 * input:
 * ```js
 * import { css } from 'ecis';
 *
 * const myClass = css`
 *   color: red;
 * `;
 * ```
 *
 * output:
 * ```js
 * const myClass = 'css-a1b2c3d4';
 * ```
 */
export function css(
  strings: TemplateStringsArray,
  ...expressions: Array<string>
): string;
