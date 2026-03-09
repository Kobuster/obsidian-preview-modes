#!/usr/bin/env bash
# release.sh — build and package a versioned release
# Usage: ./release.sh [version]
# Example: ./release.sh 0.9.6
# If no version given, reads from manifest.json

set -e

VERSION=${1:-$(node -p "require('./manifest.json').version")}
DIST="dist"
RELEASE_DIR="release"

echo "→ Building $VERSION..."
npm run build

echo "→ Packaging..."
mkdir -p "$RELEASE_DIR"

# Individual files (required by Obsidian community store)
cp "$DIST/main.js"   "$RELEASE_DIR/main.js"
cp manifest.json     "$RELEASE_DIR/manifest.json"
[ -f styles.css ] && cp styles.css "$RELEASE_DIR/styles.css"

# Zip (for BRAT and manual install convenience)
cd "$RELEASE_DIR"
zip "obsidian-preview-modes-$VERSION.zip" main.js manifest.json $([ -f styles.css ] && echo styles.css)
cd ..

echo ""
echo "✓ Release $VERSION ready in ./$RELEASE_DIR/"
echo "  Individual files: main.js, manifest.json"
echo "  BRAT zip:         obsidian-preview-modes-$VERSION.zip"
echo ""
echo "Next steps:"
echo "  git add -A && git commit -m 'release: $VERSION'"
echo "  git tag $VERSION"
echo "  git push origin main && git push origin $VERSION"
echo "  → Upload files from ./$RELEASE_DIR/ to GitHub release"
