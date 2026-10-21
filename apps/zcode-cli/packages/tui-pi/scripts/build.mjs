import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const tuiPiDirectory = resolve(import.meta.dirname, "..");

export async function buildTuiPi() {
  await build({
    entryPoints: [resolve(tuiPiDirectory, "src/index.ts")],
    outfile: resolve(tuiPiDirectory, "dist/index.js"),
    bundle: true,
    // @zcode/* workspace deps can point at TypeScript sources or unbundled
    // internals; compile that closure here. Third-party deps resolve from
    // node_modules at runtime.
    plugins: [
      {
        name: "externalize-non-zcode",
        setup(context) {
          context.onResolve({ filter: /^[^./#]/ }, (args) =>
            args.path.startsWith("@zcode/") || args.path.startsWith("node:")
              ? undefined
              : { external: true, path: args.path },
          );
        },
      },
    ],
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: true,
    logLevel: "info",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildTuiPi();
}
