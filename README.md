# @ubiquity-os/plugin-manifest-tool

CLI for generating `manifest.json` files for UbiquityOS plugins.

It supports:

- local development
- GitHub Actions builds
- Deno Deploy builds and runtime-aware environments

## Install

```bash
bun add -D @ubiquity-os/plugin-manifest-tool
```

## Usage

### Local plugin development

Run from your plugin repository root:

```bash
bun x @ubiquity-os/plugin-manifest-tool .
```

This keeps local mode unchanged and generates `short_name` as `local/<repo>@local`.

### package.json scripts

```json
{
  "scripts": {
    "prepare:manifest": "bun x @ubiquity-os/plugin-manifest-tool .",
    "prebuild": "bun run prepare:manifest && <your-existing-prebuild>",
    "predev": "bun run prepare:manifest && <your-existing-predev>"
  }
}
```

### GitHub Actions

When run without a positional project root, the tool can use:

- `GITHUB_WORKSPACE`
- `GITHUB_REPOSITORY`
- `GITHUB_REF_NAME`
- `MANIFEST_PATH`

Example:

```yaml
- uses: oven-sh/setup-bun@v2
- run: bun x @ubiquity-os/plugin-manifest-tool
  env:
    GITHUB_WORKSPACE: ${{ github.workspace }}
    GITHUB_REPOSITORY: ${{ github.repository }}
    GITHUB_REF_NAME: ${{ github.ref_name }}
    MANIFEST_PATH: ${{ github.workspace }}/manifest.json
```

### Deno Deploy builds

For GitHub-linked Deno builds, run the tool without a positional argument after preparing `deno.jsonc`:

```bash
deno deploy switch --token "$PLUGIN_MANIFEST_SWITCH_TOKEN" --app "$DENO_DEPLOY_APPLICATION_SLUG"
deno x -y @ubiquity-os/plugin-manifest-tool@latest
```

The tool resolves manifest identity in this order:

1. explicit CLI/env overrides
2. Deno context:
   - `DENO_TIMELINE`
   - `PLUGIN_MANIFEST_REPOSITORY`
   - `PLUGIN_MANIFEST_PRODUCTION_BRANCH`
   - `deno.json` / `deno.jsonc`
3. GitHub Actions env
4. git metadata
5. local fallback

`short_name` rules in Deno-aware mode:

- `git-branch/<branch>` -> `<owner>/<repo>@<branch>`
- `production` -> `<owner>/<repo>@main`
- `preview/<revision>` -> `<owner>/<repo>@<revision>`

If `DENO_TIMELINE` is unavailable during the build, the tool falls back to git metadata.

## Optional overrides

The tool accepts these optional overrides when run without a positional project root:

- `--project-root`
- `--manifest-path`
- `--repository`
- `--ref-name`
- `--production-branch`

Environment equivalents:

- `PLUGIN_MANIFEST_PROJECT_ROOT`
- `PLUGIN_MANIFEST_PATH`
- `PLUGIN_MANIFEST_REPOSITORY`
- `PLUGIN_MANIFEST_REF_NAME`
- `PLUGIN_MANIFEST_PRODUCTION_BRANCH`

## Development

```bash
bun install
bun run check
```
