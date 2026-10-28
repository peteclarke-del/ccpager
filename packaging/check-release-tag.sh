#!/usr/bin/env bash
# A release is three statements of one version: the tag, package.json, and the newest release
# in the AppStream metadata. Refuse a tag that disagrees with either, before anything is built.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_version="$(node -p 'require("'"${project_dir}"'/package.json").version')"
metadata_version="$(sed -n 's/.*<release version="\([^"]*\)".*/\1/p' "${project_dir}/packaging/io.github.ccpager.metainfo.xml" | head -n 1)"
release_tag="${1:-}"
if [[ "${metadata_version}" != "${runtime_version}" ]]; then
    echo "The newest release in the metadata is ${metadata_version}, not ${runtime_version}." >&2; exit 1
fi
if [[ "${release_tag}" != "v${runtime_version}" ]]; then
    echo "Release tag ${release_tag:-<missing>} does not match version v${runtime_version}." >&2; exit 1
fi
echo "Release tag ${release_tag}, package.json and the metadata all say ${runtime_version}."
