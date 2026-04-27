import { css } from 'ecij';

const color = 'red';
const size = '16px';

// =============================================
// 1. Function parameter shadows module variable
// =============================================
// color is a param with unknown runtime value → css should NOT be extracted
export function paramShadow(color: string) {
  return css`
    color: ${color};
  `;
}

// =============================================
// 2. Arrow function parameter shadows module variable
// =============================================
export const arrowParamShadow = (color: string) => {
  return css`
    color: ${color};
  `;
};

// =============================================
// 3. Arrow expression body with parameter
// =============================================
export const arrowExprParam = (color: string) =>
  css`
    color: ${color};
  `;

// =============================================
// 4. Param does NOT affect non-shadowed variables
// =============================================
// color param shadows, but size is not a param → size should still resolve
export function paramPartialShadow(color: string) {
  return css`
    font-size: ${size};
  `;
}

// =============================================
// 5. For-of loop variable shadows module variable
// =============================================
export function forOfShadow() {
  for (const color of ['blue', 'green']) {
    // color is a for-of variable → unknown value → NOT extracted
    console.log(
      css`
        color: ${color};
      `,
    );
  }
  // After loop, module-level color should resolve
  return css`
    color: ${color};
  `;
}

// =============================================
// 6. For-in loop variable shadows module variable
// =============================================
export function forInShadow() {
  for (const color in { blue: 1 }) {
    console.log(
      css`
        color: ${color};
      `,
    );
  }
  return css`
    color: ${color};
  `;
}

// =============================================
// 7. Catch parameter shadows module variable
// =============================================
export function catchShadow() {
  try {
    throw new Error();
  } catch (color: unknown) {
    // color is catch param → unknown value → NOT extracted
    console.log(
      css`
        color: ${color as string};
      `,
    );
  }
  // After catch, module-level color should resolve
  return css`
    color: ${color};
  `;
}

// =============================================
// 8. let without initializer shadows
// =============================================
export function letNoInit() {
  let color;
  color = 'dynamic';
  // color was declared with let but no init → shadows module-level → NOT extracted
  return css`
    color: ${color};
  `;
}

// =============================================
// 9. Variable with non-literal init shadows
// =============================================
export function nonLiteralInit() {
  const color = String('blue');
  // color has a CallExpression init, not a literal → unknown value → NOT extracted
  return css`
    color: ${color};
  `;
}

// =============================================
// 10. Default parameter value (still unknown at build time)
// =============================================
export function defaultParam(color = 'blue') {
  return css`
    color: ${color};
  `;
}

// =============================================
// 11. For-statement init variable (classic for loop)
// =============================================
export function forStatementShadow() {
  for (let color = 'blue'; color !== 'done'; color = 'done') {
    // color has a known init value inside the for-scope
    console.log(
      css`
        color: ${color};
      `,
    );
  }
  // After loop, module-level should resolve
  return css`
    color: ${color};
  `;
}

// =============================================
// 12. Static block in class (scope isolation)
// =============================================
export class MyClass {
  static style: string;
  static {
    const color = 'purple';
    MyClass.style = css`
      color: ${color};
    `;
  }
}

// =============================================
// 13. Function declaration name shadows outer variable
// =============================================
export function fnDeclShadow() {
  function color() {}
  // color is now a function declaration name → shadows module-level → NOT extracted
  return css`
    color: ${color as unknown as string};
  `;
}

// =============================================
// 14. Class declaration name shadows outer variable
// =============================================
export function classDeclShadow() {
  class color {}
  return css`
    color: ${color as unknown as string};
  `;
}

// =============================================
// 15. Function expression name does NOT shadow in containing scope
// =============================================
export function fnExprName() {
  const fn = function color() {};
  void fn;
  // The name 'color' from a function expression is only visible inside
  // the function body, not in the containing scope.
  // So module-level color ('red') should still resolve here.
  return css`
    color: ${color};
  `;
}

// =============================================
// 16. Function expression name DOES shadow inside its own body
// =============================================
export const fnExprNameInner = function color() {
  // Inside the body, 'color' refers to the function itself, not module-level.
  // So this should NOT be extracted.
  return css`
    color: ${color as unknown as string};
  `;
};

// =============================================
// 17. Class expression name DOES shadow inside its own body
// =============================================
export const classExprNameInner = class color {
  // Inside the body, 'color' refers to the class itself, not module-level.
  // So this should NOT be extracted.
  static style = css`
    color: ${color as unknown as string};
  `;
};

// =============================================
// 18. Class expression name does NOT shadow in containing scope
// =============================================
export const classExprName = class color {};
// Module-level color ('red') should still resolve here.
export const afterClassExpr = css`
  color: ${color};
`;

// =============================================
// 19. Array destructuring shadows
// =============================================
export function arrayDestructuring() {
  const [color] = ['blue'];
  return css`
    color: ${color};
  `;
}

// =============================================
// 20. Object destructuring shadows
// =============================================
export function objectDestructuring() {
  const { color } = { color: 'blue' };
  return css`
    color: ${color};
  `;
}

// =============================================
// 21. For-of with array destructuring
// =============================================
export function forOfDestructuring() {
  for (const [color] of [['blue']]) {
    console.log(
      css`
        color: ${color};
      `,
    );
  }
  return css`
    color: ${color};
  `;
}

// =============================================
// 22. Destructured function parameter
// =============================================
export function destructuredParam({ color }: { color: string }) {
  return css`
    color: ${color};
  `;
}

// =============================================
// 23. var in block scope hoists to function scope
// =============================================
export function varInBlock() {
  {
    var color = 'blue';
    const inBlock = css`
      color: ${color};
    `;
    console.log(inBlock);
  }
  // var color hoists to function scope → resolves to 'blue', not module-level 'red'
  return css`
    color: ${color};
  `;
}

// =============================================
// 24. var in for-of hoists to function scope (unknown value)
// =============================================
export function varForOf() {
  for (var color of ['blue', 'green']) {
    console.log(
      css`
        color: ${color};
      `,
    );
  }
  // var color hoists to function scope with unknown value → NOT extracted
  return css`
    color: ${color!};
  `;
}

// =============================================
// 25. var in for-in hoists to function scope (unknown value)
// =============================================
export function varForIn() {
  for (var color in { blue: 1 }) {
    console.log(
      css`
        color: ${color};
      `,
    );
  }
  // var color hoists to function scope with unknown value �� NOT extracted
  return css`
    color: ${color!};
  `;
}

// =============================================
// 26. Module-level check: everything should still resolve
// =============================================
export const finalModuleCheck = css`
  color: ${color};
  font-size: ${size};
`;
