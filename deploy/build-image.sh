#!/usr/bin/env bash
#
# Build a NOVA production image on the deploy host, without filling its disk.
#
# Why this exists
# ---------------
# The deploy host is a 38 GB VM that also runs PostgreSQL, Redis, MinIO and eleven containers.
# Docker keeps every build layer it is not told to discard, and each NOVA image is 1–2 GB. Four
# deploys in one afternoon filled the disk to 100%, at which point **PostgreSQL aborted and went
# into recovery** — the database, not the build, is what fails first. It recovered on its own once
# space was freed, but the platform was down for several minutes because of a *build*.
#
# The failure is silent in the worst way: the build only fails at the very end, in the runtime
# stage, with `chown: ... No space left on device`, long after it has consumed the space. So this
# script prunes *before* it builds and refuses to start below a floor it will not cross.
#
# Usage (on the deploy host):
#   bash deploy/build-image.sh api
#   bash deploy/build-image.sh admin
#
# Environment:
#   MIN_FREE_GB   refuse to build below this much free space (default 8)
#   NO_PRUNE=1    skip the build-cache prune (for a deliberate cache warm)

set -euo pipefail

TARGET="${1:-}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIN_FREE_GB="${MIN_FREE_GB:-8}"

case "$TARGET" in
	api)
		DOCKERFILE="services/api/Dockerfile"
		IMAGE="nova-api:prod"
		EXTRA_ARGS=()
		;;
	admin)
		DOCKERFILE="apps/admin/Dockerfile"
		IMAGE="nova-admin-ui:latest"
		# Baked into the client bundle at build time; must match what the console calls.
		EXTRA_ARGS=(--build-arg "NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE:-https://api.nova.leadup.in/api/v1}")
		;;
	*)
		echo "usage: $0 <api|admin>" >&2
		exit 2
		;;
esac

free_gb() {
	# `df` on GNU coreutils; this script runs on the Linux deploy host, not on macOS.
	df -BG --output=avail / | tail -1 | tr -dc '0-9'
}

free_before="$(free_gb)"
echo "[build] $IMAGE — ${free_before}GB free before prune (floor ${MIN_FREE_GB}GB)"

if [[ "${NO_PRUNE:-0}" != "1" ]]; then
	# Build cache only. This never touches a running container or a tagged image, so it is safe to
	# run against a live host — which is the point, because the live host is the only host.
	echo "[build] pruning build cache"
	docker builder prune -af >/dev/null
	# Dangling (untagged, unreferenced) images are the debris of failed builds.
	docker image prune -f >/dev/null
fi

free_after="$(free_gb)"
echo "[build] ${free_after}GB free after prune"

if ((free_after < MIN_FREE_GB)); then
	echo "[build] refusing to build: ${free_after}GB free is below the ${MIN_FREE_GB}GB floor." >&2
	echo "[build] A build that runs out of space does not just fail — it takes PostgreSQL into" >&2
	echo "[build] recovery, because the database is writing to the same filesystem." >&2
	exit 1
fi

cd "$REPO_DIR"
echo "[build] docker build -f $DOCKERFILE -t $IMAGE ${EXTRA_ARGS[*]:-}"

# `"${EXTRA_ARGS[@]:-}"` is not equivalent to an empty array: when the array is empty it expands to
# one empty-string argument, and docker reads that as a missing build context and prints its usage
# instead of building. The api target has no extra args, so it hit exactly that.
if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
	docker build -f "$DOCKERFILE" -t "$IMAGE" "${EXTRA_ARGS[@]}" .
else
	docker build -f "$DOCKERFILE" -t "$IMAGE" .
fi

echo "[build] $IMAGE built; $(free_gb)GB free after build"
