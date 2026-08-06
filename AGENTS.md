# pi-smart-paste

Windows-only pi extension: **smart clipboard paste** — copy files and paste their paths; falls back to images.

## Boundaries

- Source: `extensions/clipboard-paste.ts` (single file, Windows-only).
- Depends on PowerShell `-STA` + `System.Windows.Forms` (`Clipboard.GetFileDropList()` / `GetImage()`).
- Do **not** add non-Windows code paths without a platform probe.
- Published package keeps user-facing strings (`notify`, command/shortcut `description`) in **English**. The author's personal global copy (Chinese strings) lives outside this repo.

## Conventions

- One PowerShell round-trip per paste (files first, then image), UTF-8 output so non-ASCII paths survive.
- `peerDependencies` only lists `@earendil-works/pi-coding-agent` (type-only import). Never bundle pi core packages.
- `files` whitelist = `extensions`, `README.md`, `LICENSE`.

## Release

1. Bump `version` in `package.json`.
2. `npm publish` (npm account: `ccchimneyyy`).
3. Tag and push: `git tag v<x.y.z> && git push origin v<x.y.z>`.
4. Update the `pi install` ref if you publish a new major.
