import { css as styled } from 'ecij';

// Bindings are hoisted to the top of their scope: a local `styled` declared
// *after* a template still shadows the ecij tag at the template's position, so
// none of the shadowed templates below may be extracted. At runtime they hit a
// TDZ error, a hoisted function or an unassigned `var` — never ecij's `css`.

export function laterConst() {
  // @ts-expect-error -- used before its declaration (TDZ at runtime)
  const shadowed = styled`
    color: red;
  `;
  const styled = String.raw;
  return [shadowed, styled];
}

export function laterVar() {
  // @ts-expect-error -- used before being assigned (still `undefined` at runtime)
  const shadowed = styled`
    color: green;
  `;
  var styled = String.raw;
  return [shadowed, styled];
}

export function laterFunction() {
  const shadowed = styled`
    color: blue;
  `;
  function styled(strings: TemplateStringsArray) {
    return strings.raw.join('');
  }
  return shadowed;
}

export function laterClass() {
  // @ts-expect-error -- used before its declaration (TDZ at runtime)
  const shadowed = styled`
    color: purple;
  `;
  class styled {}
  return [shadowed, styled];
}

export function selfReference() {
  // @ts-expect-error -- the tag is the very binding being declared (TDZ at runtime)
  const styled = styled`
    color: orange;
  `;
  return styled;
}

export function enclosingScope() {
  // Resolved in the enclosing function scope, whose `styled` is declared later
  const inner = () => styled`
    color: pink;
  `;
  const styled = String.raw;
  return [inner(), styled];
}

export function nestedBlock() {
  // A `styled` declared in a nested block does not reach out here: extracted
  const extracted = styled`
    color: teal;
  `;
  {
    const styled = String.raw;
    console.log(styled`nested`);
  }
  return extracted;
}

export const moduleLevel = styled`
  color: gold;
`;
