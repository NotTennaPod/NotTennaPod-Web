// Builds the app into dist/: hashed assets under dist/assets and an
// index.html naming them. The server embeds dist/ (scripts/install-into-server.mjs).
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "assets"), { recursive: true });

const result = await esbuild.build({
  entryPoints: { app: join(root, "src", "main.tsx") },
  bundle: true,
  format: "esm",
  target: ["es2022", "safari17", "firefox128", "chrome120"],
  outdir: join(dist, "assets"),
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: true,
  sourcemap: false,
  legalComments: "linked",
  metafile: true,
  loader: { ".svg": "text", ".ttf": "file", ".woff2": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

const outputs = Object.keys(result.metafile.outputs).map((p) => basename(p));
const js = outputs.find((f) => f.startsWith("app-") && f.endsWith(".js"));
const css = outputs.find((f) => f.startsWith("app-") && f.endsWith(".css"));
if (!js) throw new Error("build: no app script");
let html = readFileSync(join(root, "src", "index.html"), "utf8");
html = html.replace("<!-- styles -->", css ? `<link rel="stylesheet" href="/assets/${css}">` : "");
html = html.replace("<!-- script -->", `<script type="module" src="/assets/${js}"></script>`);
writeFileSync(join(dist, "index.html"), html);
console.log(`build: ${outputs.join(", ")}`);
