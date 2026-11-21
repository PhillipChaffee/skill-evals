#!/usr/bin/env bash
# The guards on a release. It refuses a version that must not ship, and says
# whether the version in package.json still has to be published. It only reads:
# the registry, the history, and two files.
#
#   release-plan.sh           checks the version; for pull requests
#   release-plan.sh release   also checks the pushed tag; for the publish workflow
#
# Prints version= and publish= lines in the form $GITHUB_OUTPUT takes.
set -euo pipefail

fail() {
	echo "release guard: $1" >&2
	exit 1
}

# The version of a package spec on the registry, or nothing when the registry
# has none. Any failure other than "not found" stops the release: an unreachable
# registry must not look like an unpublished version.
registry_version() {
	local out
	if out=$(npm view "$1" version 2>&1); then
		echo "$out"
	elif [[ $out != *E404* ]]; then
		fail "could not ask the registry about $1: $out"
	fi
}

name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")

[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
	fail "version \"$version\" is not MAJOR.MINOR.PATCH"
grep -qx "## $version" CHANGELOG.md ||
	fail "CHANGELOG.md has no \"## $version\" entry"

if [[ ${1:-} == release ]]; then
	[[ ${GITHUB_REF_NAME:-} == "v$version" ]] ||
		fail "the tag ${GITHUB_REF_NAME:-} is not v$version, the version in package.json at that commit"
	git merge-base --is-ancestor "$GITHUB_SHA" origin/main ||
		fail "the tagged commit $GITHUB_SHA is not on main"
fi

publish=false
if [[ $(registry_version "$name@$version") != "$version" ]]; then
	latest=$(registry_version "$name")
	if [[ -n $latest ]]; then
		newest=$(printf '%s\n%s\n' "$latest" "$version" | sort -V | tail -n 1)
		[[ $newest == "$version" && $latest != "$version" ]] ||
			fail "version $version is not above $latest, the latest on the registry"
	fi
	publish=true
fi

echo "version=$version"
echo "publish=$publish"
