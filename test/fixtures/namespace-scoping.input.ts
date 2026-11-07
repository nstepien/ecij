import { css } from 'ecij';

// Namespaces are not supported, but their declarations must not leak into the module scope

const accent = 'blue';

// @ts-expect-error -- namespaces are not erasable syntax
export namespace Theme {
  export const accent = 'red';
  export const css = String.raw;
}

// Neither the namespace's `css` nor its `accent` overrides the module's
export const moduleClass = css`
  color: ${accent};
`;
