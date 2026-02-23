import esbuild, { BuildOptions } from "esbuild";

const typescriptEntries = ["src/main.ts"];
const cssEntries = ["static/style.css"];
const entries = [...typescriptEntries, ...cssEntries];

const DATA_URL_LOADERS = [".png", ".woff", ".woff2", ".eot", ".ttf", ".svg"];

export const esbuildOptions: BuildOptions = {
  sourcemap: true,
  entryPoints: entries,
  bundle: true,
  minify: false,
  loader: Object.fromEntries(DATA_URL_LOADERS.map((ext) => [ext, "dataurl"])),
  outdir: "static/dist",
};

async function runBuild() {
  try {
    await esbuild.build(esbuildOptions);
    console.log("\tesbuild complete");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

void runBuild();
