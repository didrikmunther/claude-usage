#!/usr/bin/env bash
# Cut a release: bump VERSION, commit, tag vX.Y.Z, push. Installs pick it up via
# `git ls-remote --tags` and offer it as an update. Usage: ./release.sh 0.2.0
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
V="${1:-}"

[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "usage: ./release.sh X.Y.Z"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "✗ commit/stash your changes first"; exit 1; }
git rev-parse "v$V" >/dev/null 2>&1 && { echo "✗ tag v$V already exists"; exit 1; }

echo "$V" > VERSION
git add VERSION
git commit -m "Release v$V"
git tag -a "v$V" -m "v$V"        # annotated: message can carry release notes
git push origin HEAD
git push origin "v$V"
echo "✓ released v$V"
