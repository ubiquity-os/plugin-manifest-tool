# @ubiquity-os/plugin-manifest-tool

CLI for generating `manifest.json` files for UbiquityOS plugins.

It is the extracted `update-manifest` implementation used by `ubiquity-os/action-deploy-plugin`, packaged for direct use with `bun x` or local installs.

## Install

```bash
bun add -D @ubiquity-os/plugin-manifest-tool
```

## Usage

### Local plugin development

Run from your plugin repository root:

```bash
bunx @ubiquity-os/plugin-manifest-tool@latest
```

The command reads your plugin source and writes/updates `manifest.json` in the current directory.
You can still pass a project path (for example `.` or `./packages/my-plugin`) when needed.

### package.json scripts

```json
{
  "scripts": {
    "prepare:manifest": "bunx @ubiquity-os/plugin-manifest-tool@latest",
    "prebuild": "bun run prepare:manifest && <your-existing-prebuild>",
    "predev": "bun run prepare:manifest && <your-existing-predev>"
  }
}
```

### CI / GitHub Actions

```yaml
- uses: oven-sh/setup-bun@v2
- run: bunx @ubiquity-os/plugin-manifest-tool@latest
```

No workflow-level Deno setup is required. The package bundles a Deno runner through npm dependencies and falls back to a global `deno` binary when available.

## Optional environment overrides

The CLI now works out of the box with no env setup.
When env vars are present they are still honored:

- `MANIFEST_PATH` (defaults to `<projectRoot>/manifest.json`)
- `GITHUB_WORKSPACE` (defaults to current working directory)
- `GITHUB_REPOSITORY` (falls back to git remote `origin`, then `local/<dir>`)
- `GITHUB_REF_NAME` / `GITHUB_REF` (falls back to current git branch, then `local`)

This keeps compatibility with existing `action-deploy-plugin` flows while making local usage simple.

### Runtime override

If you need a specific Deno binary path, set:

```bash
export PLUGIN_MANIFEST_DENO_BIN=/path/to/deno
```

## Development

```bash
bun install
bun run check
```
