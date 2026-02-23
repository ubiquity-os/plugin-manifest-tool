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
bun x @ubiquity-os/plugin-manifest-tool .
```

The command reads your plugin source and writes/updates `manifest.json` in the provided project directory.

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

### CI / GitHub Actions

```yaml
- uses: oven-sh/setup-bun@v2
- run: bun x @ubiquity-os/plugin-manifest-tool .
```

## CI mode environment variables

The CLI supports two modes:

- Local mode: pass a project root argument (for example `.`).
- CI mode: when no positional argument is passed, it reads:
  - `MANIFEST_PATH`
  - `GITHUB_WORKSPACE`
  - `GITHUB_REPOSITORY`
  - `GITHUB_REF_NAME`

This preserves compatibility with existing `action-deploy-plugin` flows.

## Development

```bash
bun install
bun run check
```
