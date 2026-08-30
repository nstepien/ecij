import { css } from 'ecij';

const color = 'red';
const size = '16px';

// `var` bindings are hoisted to the function scope, but a template's
// interpolations are still evaluated where the template appears.
export function varInBlock() {
  {
    const color = 'blue';
    const padding = '4px';
    // `color` is the block's 'blue', not the module's 'red'
    var shadowed = css`
      color: ${color};
      font-size: ${size};
    `;
    // `padding` only exists inside the block
    var padded = css`
      padding: ${padding};
    `;
  }

  // The bindings are usable out here, and `color` is the module's 'red' again
  return css`
    &.${shadowed},
    &.${padded} {
      color: ${color};
    }
  `;
}

export function varInLoop() {
  for (const color of ['green', 'purple']) {
    // The loop variable has no static value: not extracted
    var perIteration = css`
      color: ${color};
    `;
    console.log(perIteration);
  }
}
