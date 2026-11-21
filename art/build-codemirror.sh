#!/bin/sh
# Rebuilds public/vendor/codemirror/cm.min.js from art/codemirror-entry.js.
# Needs a folder with these npm packages installed (not part of the app's own dependencies):
#   codemirror @codemirror/{state,view,commands,search,language,lang-javascript,lang-python,lang-html,lang-css,
#   lang-json,lang-markdown,lang-yaml,lang-sql,lang-cpp,lang-java,lang-rust,lang-go,lang-php,lang-xml,legacy-modes} esbuild
# Usage: sh art/build-codemirror.sh /path/to/that/folder
set -e
B="$1"; HERE="$(cd "$(dirname "$0")/.." && pwd)"
cp "$HERE/art/codemirror-entry.js" "$B/entry.js"
(cd "$B" && npx esbuild entry.js --bundle --format=esm --minify --legal-comments=none --outfile="$HERE/public/vendor/codemirror/cm.min.js")
