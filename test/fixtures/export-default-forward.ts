// `export default` snapshots the binding when this statement runs: `tone` is a
// hoisted `var` that is still undefined here, so the default export is not
// 'peru' at runtime.
// @ts-expect-error -- used before being assigned (undefined at runtime)
export default tone;

var tone = 'peru';
