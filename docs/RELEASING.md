# Release checklist

This repository has **two independent release surfaces**. Doing one does not
update the other:

1. **Git tags** (`git push origin vX.Y.Z`) update the Tags page and the code.
2. **GitHub Releases** (`https://github.com/zx-yk/dsh-codex-adapter/releases`)
   are separate objects. They are created by
   `.github/workflows/github-release.yml` on a tag push, or backfilled with
   `npm run github:releases`.

## Normal release

```bash
cd D:\\123\\pc-fix\\dsh-codex-adapter
npm test
npm run build
npm run smoke:pack
node scripts/bump-version.mjs X.Y.Z
# bump-version rebuilds and updates README Latest; commit the generated files
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m vX.Y.Z
git push origin main
git push origin vX.Y.Z
npm publish --access public --tag latest
```

After the tag push, open **Actions → github-release** and confirm the run
created `vX.Y.Z`. Do not stop at `npm publish`: npm, git tags and GitHub
Releases are three different destinations.

## Missing/backfilled releases

```powershell
$env:GH_TOKEN = "<PAT with Contents: write>"
npm run github:releases
```

The script creates a release for every `v*` tag that has none. It is safe to
run again: existing releases are skipped.

## Why this file exists

A release was published to npm and tagged in git while the GitHub Releases page
still showed an older version. That was not a failed push; it was a missed
third surface. Future releases must verify all three.
