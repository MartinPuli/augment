// Bundles the real LiveViewWidget + detector worker + Tailwind CSS into <out>/ for a standalone
// browser check (no Next server needed). Run from the repo root:
//   node scripts/vision-harness/build.mjs /tmp/ghost-harness
//   pnpm exec tsx scripts/vision-harness-server.ts /tmp/ghost-harness 4799
//   node scripts/vision-harness/cdp.mjs "http://localhost:4799/" 45 "20,45" shot   (headless Chrome)
// Query params: ?kind=hls|image_poll|local_camera|webrtc&u=<upstream url>&classes=car,truck
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const R = process.cwd();
// pnpm is strict: reach esbuild through tsx and postcss through @tailwindcss/postcss
const rootReq = createRequire(`${R}/package.json`);
const { build } = createRequire(rootReq.resolve("tsx"))("esbuild");
const twPath = rootReq.resolve("@tailwindcss/postcss");
const tw = rootReq("@tailwindcss/postcss");
const postcss = createRequire(twPath)("postcss");
const out = path.resolve(process.argv[2] ?? "/tmp/ghost-harness");
const here = path.join(R, "scripts/vision-harness");
fs.mkdirSync(path.join(out, "out"), { recursive: true });
fs.copyFileSync(path.join(here, "index.html"), path.join(out, "index.html"));
const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", absWorkingDir: R, tsconfig: `${R}/tsconfig.json`, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "warning", jsx: "automatic", nodePaths: [`${R}/node_modules`] };
await build({ ...common, entryPoints: [path.join(here, "main.tsx")], outfile: path.join(out, "out/main.js"), external: ["@/lib/connector/webrtc"] });
// detector.ts does `new Worker(new URL("./detector.worker.ts", import.meta.url))` -> /out/detector.worker.ts(.js)
await build({ ...common, entryPoints: [`${R}/src/lib/vision/detector.worker.ts`], outfile: path.join(out, "out/detector.worker.ts.js") });
const css = fs.readFileSync(`${R}/src/app/globals.css`, "utf8");
const res = await postcss([tw({ base: R })]).process(css, { from: `${R}/src/app/globals.css` });
fs.writeFileSync(path.join(out, "out/app.css"), res.css);
console.log(`built harness into ${out}`);
