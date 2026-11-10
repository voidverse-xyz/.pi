// Resolve the same installed public module identities used by Pi's extension loader.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { sdkAliases } from "./runtime.mjs";

const roots = Object.fromEntries(Object.entries(sdkAliases()).map(([name, path]) => [name, pathToFileURL(path).href]));
register(`data:text/javascript,${encodeURIComponent(`
const roots = ${JSON.stringify(roots)};
export async function resolve(specifier, context, nextResolve) {
  if (Object.hasOwn(roots, specifier)) return { url: roots[specifier], shortCircuit: true };
  return nextResolve(specifier, context);
}
`)}`, import.meta.url);
