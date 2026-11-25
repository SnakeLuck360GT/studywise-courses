#!/usr/bin/env bash
# Creates the GitHub release for the current version and uploads the installers.
# The Intel Mac and Windows builds need @napi-rs/canvas-darwin-x64 and
# @napi-rs/canvas-win32-x64-msvc in node_modules (npm only installs this Mac's).
#
#   GITHUB_TOKEN=... scripts/release.sh
#
# The token needs "Contents: read and write" on this repo (fine-grained) or the
# "repo" scope (classic). Build first with: npm run dist && npm run dist:win
set -euo pipefail

REPO="SnakeLuck360GT/studywise-courses"
VERSION="v$(node -p "require('./package.json').version")"
NOTES="docs/release-notes-${VERSION}.md"
# latest*.yml and the blockmaps are what installed copies read to update themselves.
# latest*.yml go last: they point at the installers, so those must be up first.
# A platform that wasn't built this time is left out (a Windows-only release
# is fine), but each platform that was built needs all of its files.
MAC=(release/Studywise-Courses.dmg release/Studywise-Courses-mac.zip release/Studywise-Courses-mac.zip.blockmap release/latest-mac.yml)
WIN=(release/Studywise-Courses-Setup.exe release/Studywise-Courses-win-x64.zip release/Studywise-Courses-Setup.exe.blockmap release/latest.yml)

: "${GITHUB_TOKEN:?Set GITHUB_TOKEN first}"
version_ok() { grep -q "^version: ${VERSION#v}$" "$1" 2>/dev/null; }
INSTALLERS=() FEEDS=()
add_platform() { # name, then its files: three installers/blockmaps and its latest*.yml last
  local name=$1; shift
  local feed=${*: -1}
  if ! version_ok "$feed"; then echo "No ${VERSION#v} build for $name ($feed missing or another version), leaving it out."; return; fi
  for f in "$@"; do [ -f "$f" ] || { echo "Missing $f. Build it again (npm run dist / npm run dist:win)."; exit 1; }; done
  INSTALLERS+=("$1" "$2" "$3") FEEDS+=("$feed")
}
add_platform Mac "${MAC[@]}"
add_platform Windows "${WIN[@]}"
[ ${#FEEDS[@]} -gt 0 ] || { echo "Nothing built for ${VERSION#v}. Run npm run dist and/or npm run dist:win."; exit 1; }
ASSETS=("${INSTALLERS[@]}" "${FEEDS[@]}")

api() { curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

# Make sure the tag exists on GitHub.
git rev-parse "$VERSION" >/dev/null 2>&1 || git tag -a "$VERSION" -m "$VERSION"
git push -q origin "$VERSION" 2>/dev/null || true

# Reuse the release if it already exists (a draft from a run that stopped
# halfway too), otherwise create it as a draft. Installed copies only see it
# once it's published at the end, with every file in place: a release that's
# out before its latest.yml makes their update check fail.
id=$(api "https://api.github.com/repos/$REPO/releases?per_page=50" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).find(x=>x.tag_name===process.argv[1]);console.log(r?r.id:"")}catch{console.log("")}})' "$VERSION")
if [ -z "$id" ]; then
  body=$(node -e 'const fs=require("fs");console.log(JSON.stringify({tag_name:process.argv[1],name:"Studywise Courses "+process.argv[1].slice(1),draft:true,body:fs.existsSync(process.argv[2])?fs.readFileSync(process.argv[2],"utf8"):""}))' "$VERSION" "$NOTES")
  # GitHub sometimes refuses this straight after the tag is pushed: try a few times.
  for try in 1 2 3 4 5; do
    id=$(api -X POST "https://api.github.com/repos/$REPO/releases" -d "$body" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id||"")}catch{console.log("")}})')
    [ -n "$id" ] && break
    echo "Couldn't create the release yet (try $try of 5), waiting…"
    sleep $((try * 3))
  done
  [ -n "$id" ] || { echo "GitHub wouldn't create the release. Run this script again: it picks up where it left off."; exit 1; }
  echo "Created release $VERSION ($id)"
else
  echo "Release $VERSION exists ($id), uploading assets"
fi

for f in "${ASSETS[@]}"; do
  name=$(basename "$f")
  # Replace an asset with the same name if it's already there.
  old=$(api "https://api.github.com/repos/$REPO/releases/$id/assets" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(a?a.id:"")})' "$name")
  [ -n "$old" ] && api -X DELETE "https://api.github.com/repos/$REPO/releases/assets/$old" >/dev/null
  echo "Uploading $name ($(du -h "$f" | cut -f1))..."
  api -X POST -H "Content-Type: application/octet-stream" --data-binary @"$f" \
    "https://uploads.github.com/repos/$REPO/releases/$id/assets?name=$name" >/dev/null
done

# Publish it (and make it the latest release): installed copies pick it up from here.
api -X PATCH "https://api.github.com/repos/$REPO/releases/$id" -d '{"draft":false,"make_latest":"true"}' >/dev/null

echo "Done: https://github.com/$REPO/releases/tag/$VERSION"
