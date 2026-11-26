#!/usr/bin/env bash
# Makes the GitHub CLI available. Keeps an installed gh (at least GH_SETUP_MIN_VERSION when set); otherwise installs the
# pinned release for the runner's architecture under RUNNER_TEMP, without root, after checking its SHA-256.
set -euo pipefail

version="${GH_SETUP_VERSION:-2.103.3}"
sha256_amd64="${GH_SETUP_SHA256_AMD64:-4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d}"
sha256_arm64="${GH_SETUP_SHA256_ARM64:-ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63}"
min_version="${GH_SETUP_MIN_VERSION:-}"

installed_version() {
  gh --version 2>/dev/null | sed -n 's/^gh version \([0-9][0-9.]*\).*/\1/p' | head -n 1
}

# version_at_least <version> <minimum>
version_at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

if command -v gh >/dev/null 2>&1; then
  current="$(installed_version)"
  if [ -z "$min_version" ] || { [ -n "$current" ] && version_at_least "$current" "$min_version"; }; then
    echo "GitHub CLI ${current:-of unknown version} is already installed at $(command -v gh)."
    exit 0
  fi
  echo "GitHub CLI ${current:-of unknown version} is older than ${min_version}; installing ${version}."
fi

if [ -n "$min_version" ] && ! version_at_least "$version" "$min_version"; then
  echo "::error::The pinned GitHub CLI ${version} is older than the required ${min_version}."
  exit 1
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64)
    arch=amd64
    sha256="$sha256_amd64"
    ;;
  Linux-aarch64 | Linux-arm64)
    arch=arm64
    sha256="$sha256_arm64"
    ;;
  *)
    echo "::error::No pinned GitHub CLI build for $(uname -s)-$(uname -m); install gh on the runner."
    exit 1
    ;;
esac

name="gh_${version}_linux_${arch}"
dir="${RUNNER_TEMP:?RUNNER_TEMP is not set}/gh-${version}"
archive="${dir}/${name}.tar.gz"
mkdir -p "$dir"
curl -fsSL --retry 3 --output "$archive" "https://github.com/cli/cli/releases/download/v${version}/${name}.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | cut -d ' ' -f 1)"
else
  actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
fi
if [ "$actual" != "$sha256" ]; then
  rm -f "$archive"
  echo "::error::Checksum mismatch for ${name}.tar.gz: expected ${sha256}, got ${actual}."
  exit 1
fi

tar -xzf "$archive" -C "$dir"
rm -f "$archive"
bin="${dir}/${name}/bin"
"${bin}/gh" --version >/dev/null
echo "$bin" >> "${GITHUB_PATH:?GITHUB_PATH is not set}"
echo "Installed GitHub CLI ${version} (${arch}) at ${bin}/gh."
