#!/usr/bin/env bash
#
# Build the Debian package: the gateway and CLI (Node.js), the settings window (Python/GTK 4)
# and the desktop integration. Nothing is compiled, so one package serves every architecture.
#
#   packaging/build-deb.sh [OUTPUT_DIR]
#
# Needs dpkg-deb (dpkg-dev on Debian/Ubuntu).
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${1:-${project_dir}/dist}"
package_version="$(node -p 'require("'"${project_dir}"'/package.json").version')"

if [[ "${package_version}" == *-* ]]; then
    echo "The project version must not contain a Debian revision separator: ${package_version}" >&2
    exit 1
fi

build_dir="$(mktemp -d)"
trap 'rm -rf -- "${build_dir}"' EXIT
package_root="${build_dir}/ccpager_${package_version}_all"
app="${package_root}/usr/lib/ccpager"
doc_dir="${package_root}/usr/share/doc/ccpager"

install -d "${app}" "${package_root}/usr/bin" "${package_root}/usr/share/applications" \
    "${package_root}/usr/share/metainfo" "${package_root}/usr/share/icons/hicolor/scalable/apps" \
    "${doc_dir}" "${package_root}/DEBIAN" "${output_dir}"

cp -r "${project_dir}/bin" "${project_dir}/src" "${project_dir}/gui" "${app}/"
install -m 0644 "${project_dir}/package.json" "${app}/package.json"
find "${app}" -name '__pycache__' -prune -exec rm -rf {} +
# Tells `ccpager update` this copy came from the package, so it updates with the next .deb.
printf 'deb all\n' > "${app}/package-target"
chmod -R go-w "${app}"
chmod 0755 "${app}/bin/ccpager.js" "${app}/gui/ccpager_gui.py"

install -m 0755 "${project_dir}/packaging/ccpager" "${package_root}/usr/bin/ccpager"
install -m 0644 "${project_dir}/packaging/io.github.ccpager.desktop" "${package_root}/usr/share/applications/"
install -m 0644 "${project_dir}/packaging/io.github.ccpager.metainfo.xml" "${package_root}/usr/share/metainfo/"
install -m 0644 "${project_dir}/gui/ccpager.svg" "${package_root}/usr/share/icons/hicolor/scalable/apps/ccpager.svg"
install -m 0644 "${project_dir}/README.md" "${project_dir}/SECURITY.md" "${doc_dir}/"
install -m 0644 "${project_dir}/LICENSE" "${doc_dir}/copyright"
install -m 0755 "${project_dir}/packaging/postinst" "${package_root}/DEBIAN/postinst"
install -m 0755 "${project_dir}/packaging/postrm" "${package_root}/DEBIAN/postrm"

installed_size="$(du -sk "${package_root}/usr" | cut -f1)"
cat > "${package_root}/DEBIAN/control" <<CONTROL
Package: ccpager
Version: ${package_version}
Section: devel
Priority: optional
Architecture: all
Installed-Size: ${installed_size}
Maintainer: Pete Clarke <peteclarke-del@users.noreply.github.com>
Depends: nodejs (>= 18), python3 (>= 3.10), python3-gi, gir1.2-gtk-4.0, gir1.2-adw-1
Recommends: policykit-1
Homepage: https://github.com/peteclarke-del/ccpager
Description: Local gateway that trims Claude Code requests before they count against your plan
 ccpager sits between Claude Code and the Anthropic API on 127.0.0.1. It pages
 stale tool output out of each request when that is cheaper than resending it,
 shows your plan's 5-hour and weekly usage with a predicted run-out time, and
 can start new sessions on a cheaper model when a limit is under pressure.
 Includes the ccpager command and a GTK 4 settings window.
CONTROL

artifact="${output_dir}/ccpager_${package_version}_all.deb"
dpkg-deb --root-owner-group --build "${package_root}" "${artifact}"
echo "Created ${artifact}"
