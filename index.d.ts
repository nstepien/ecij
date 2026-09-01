/**
 * Tags a CSS template literal for static extraction.
 *
 * At build time the plugin moves the CSS into a separate stylesheet and replaces the tag with the
 * generated class name, so nothing of `css` is left in the bundle. Interpolations must be
 * statically resolvable — string or number literals, identifiers holding one, or class names
 * produced by another `css` tag, including values imported from other modules.
 *
 * @returns The generated class name.
 * @throws If the tag is still evaluated at runtime, which means the plugin did not extract it.
 * @example
 * <caption>Source</caption>
 * ```js
 * import { css } from 'ecij';
 *
 * const myClass = css`
 *   color: red;
 * `;
 * ```
 * @example
 * <caption>Bundled JavaScript</caption>
 * ```js
 * const myClass = 'css-a1b2c3d4';
 * ```
 * @example
 * <caption>Extracted CSS</caption>
 * ```css
 * .css-a1b2c3d4 {
 *   color: red;
 * }
 * ```
 * @see [ecij documentation](https://github.com/nstepien/ecij#readme)
 */
export function css(strings: TemplateStringsArray, ...expressions: Array<string | number>): string;
