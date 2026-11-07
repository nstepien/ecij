import { fontSize } from './imported-literals';
import { redClass } from './imported-style';

const color = 'teal';

export { color as 'string name' };

// Imports exported again
export { fontSize as reexportedSize, redClass as reexportedClass };

export const { destructured } = { destructured: 'navy' };

export { fontWeight as reexported } from './imported-literals';

export default color;
