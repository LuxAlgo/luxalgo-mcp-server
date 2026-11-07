/*
  Builds the chart view (view/chart/) into ONE self-contained HTML document,
  dist/chart/vela-chart.html, which tools/chart serves as ui://vela/chart.
  Vela's open-source core, its Hyperliquid and Binance providers and the
  ext-apps App bridge are bundled inline: the document loads nothing from a
  CDN, so the host's CSP only has to allow the exchange APIs.

  Usage: npm run build:chart (after npm run build). Vercel runs both through
  `vercel-build`; the Docker image and `npm run build` alone skip the view, so
  the chart tools (off by default) serve a "not built" page there.
*/
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "chart", "vela-chart.html");

const result = await build({
  entryPoints: [join(root, "view", "chart", "main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  write: false,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});

// An inline <script> ends at the first "</script" anywhere in its text.
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = await readFile(join(root, "view", "chart", "index.html"), "utf8");
const marker = "/*__BUNDLE__*/";
if (!template.includes(marker)) throw new Error("view/chart/index.html lost its bundle marker");
// The Vela version the view bundles: the server reads it (tools/chart/tools.ts, chartViewVelaVersion) to
// know what the view can chart, e.g. Hyperliquid HIP-3 perpetuals from Vela 0.10.2 on.
const velaVersion = JSON.parse(await readFile(join(root, "node_modules", "@luxalgo", "vela", "package.json"), "utf8")).version;
if (!/^[0-9A-Za-z.+-]{1,40}$/.test(velaVersion)) throw new Error(`unexpected @luxalgo/vela version "${velaVersion}"`);
const html = template
  .replace("<head>", () => `<head>\n    <meta name="vela-version" content="${velaVersion}" />`)
  .replace(marker, () => js);

await mkdir(dirname(out), { recursive: true });
await writeFile(out, html);
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`chart view (Vela ${velaVersion}): ${out} — ${kb(Buffer.byteLength(html))} raw, ${kb(gzipSync(html).length)} gzipped`);
