// Lets a test import the app's .tsx components: Node strips TypeScript types
// but does not compile JSX, so .tsx modules are compiled with esbuild (as the
// build does) when they load.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, "utf8"), { loader: "tsx", format: "esm", jsx: "automatic", jsxImportSource: "preact", sourcefile: file });
    return { format: "module", source: code, shortCircuit: true };
  },
});
