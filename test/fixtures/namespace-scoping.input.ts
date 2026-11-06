import { css } from 'ecij';

// The declarations of a namespace are scoped to its body

const accent = 'blue';

// @ts-expect-error -- namespaces are not erasable syntax
export namespace Theme {
  const accent = 'red';
  export const muted = 'gray';

  // The bindings of the namespace shadow outer bindings inside it
  export const accentClass = css`
    color: ${accent};
  `;
}

// …but not outside of it
export const moduleAccentClass = css`
  color: ${accent};
`;

// @ts-expect-error -- namespaces are not erasable syntax
export namespace Theme {
  // The exports of its other blocks do not resolve, as Rolldown does not
  // resolve them either → NOT extracted
  export const mutedClass = css`
    color: ${muted};
  `;
}

// @ts-expect-error -- namespaces are not erasable syntax
export namespace Fake {
  const css = String.raw;

  // The namespace's own `css` shadows the import inside it → NOT extracted
  export const fakeClass = css`
    color: green;
  `;
}

// …but not outside of it
export const moduleClass = css`
  color: blue;
`;
