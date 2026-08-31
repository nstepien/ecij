import { css } from 'ecij';

import { accentColor, accentSize, accentClass } from './named-styles';

// =============================================
// Module-level declarations
// =============================================
const color = 'red';
const size = '16px';
const weight = 'bold';

// Module-level CSS using module-level variables
export const topLevelStyle = css`
  color: ${color};
  font-size: ${size};
  font-weight: ${weight};
`;

// =============================================
// 1. Function scope shadows module-level variable
// =============================================
export function functionShadow() {
  const color = 'blue';
  // Should use the LOCAL 'blue', not module-level 'red'
  return css`
    color: ${color};
    font-size: ${size};
  `;
}

// Module-level AFTER function shadow: should still use 'red'
export const afterFunctionShadow = css`
  color: ${color};
`;

// =============================================
// 2. Nested function scopes (3 levels)
// =============================================
export function level1() {
  const color = 'green';
  const l1only = '10px';

  function level2() {
    const color = 'purple';
    const l2only = '20px';

    function level3() {
      const color = 'orange';
      // Should use orange (level3), 20px (level2), 10px (level1)
      return css`
        color: ${color};
        padding: ${l2only};
        margin: ${l1only};
      `;
    }

    // Should use purple (level2), 10px (level1)
    const l2style = css`
      color: ${color};
      margin: ${l1only};
    `;

    return { l2style, level3: level3() };
  }

  // Should use green (level1)
  const l1style = css`
    color: ${color};
    padding: ${l1only};
  `;

  return { l1style, level2: level2() };
}

// Module-level after nested functions: should still use 'red'
export const afterNestedFunctions = css`
  color: ${color};
`;

// =============================================
// 3. Arrow function scope
// =============================================
export const arrowShadow = () => {
  const color = 'cyan';
  return css`
    color: ${color};
  `;
};

// Module-level after arrow: should still use 'red'
export const afterArrowShadow = css`
  color: ${color};
`;

// =============================================
// 4. Block scope (if/for/plain blocks)
// =============================================
export function blockScope() {
  const bg = 'white';

  const beforeBlock = css`
    background: ${bg};
  `;

  {
    const bg = 'black';
    const inBlock = css`
      background: ${bg};
    `;
    console.log(inBlock);
  }

  // After block: should still use 'white'
  const afterBlock = css`
    background: ${bg};
  `;

  return { beforeBlock, afterBlock };
}

// =============================================
// 5. Import shadowing
// =============================================
export function shadowsImport() {
  const accentColor = 'black';
  // Should use local 'black', not imported 'crimson'
  return css`
    color: ${accentColor};
  `;
}

// Module-level using import: should use imported 'crimson'
export const usesImport = css`
  color: ${accentColor};
  font-size: ${accentSize}px;
`;

// Module-level using imported class
export const usesImportedClass = css`
  &.${accentClass} {
    display: block;
  }
`;

// =============================================
// 6. CSS class names as interpolations across scopes
// =============================================
const baseClass = css`
  display: flex;
`;

export function shadowsCssClass() {
  const baseClass = css`
    display: grid;
  `;
  // Should reference the LOCAL baseClass (display: grid), not module-level
  return css`
    &.${baseClass} {
      gap: 10px;
    }
  `;
}

// Module-level: should reference module-level baseClass (display: flex)
export const usesBaseClass = css`
  &.${baseClass} {
    align-items: center;
  }
`;

// =============================================
// 7. var declarations (function-scoped)
// =============================================
export function varDeclaration() {
  var color = 'magenta';
  // a `var` shadows module-level color but, not being a `const`, is never resolved
  return css`
    color: ${color};
  `;
}

// Module-level after var in function: should still use 'red'
export const afterVarDecl = css`
  color: ${color};
`;

// =============================================
// 8. Sequential blocks with same variable name
// =============================================
export function sequentialBlocks() {
  {
    const color = 'navy';
    const block1 = css`
      color: ${color};
    `;
    console.log(block1);
  }

  {
    const color = 'olive';
    const block2 = css`
      color: ${color};
    `;
    console.log(block2);
  }

  // After both blocks, module-level color should work
  return css`
    color: ${color};
  `;
}

// Final module-level check: should use 'red'
export const finalModuleStyle = css`
  color: ${color};
  font-size: ${size};
  font-weight: ${weight};
`;
