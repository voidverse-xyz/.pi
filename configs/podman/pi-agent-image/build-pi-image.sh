#!/usr/bin/env bash

set -Eeuo pipefail

readonly DEFAULT_IMAGE_TAG="localhost/pi-agent-fedora:44"
readonly PREINSTALLED_LABEL_VERSION="2"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly CONTAINERFILE="$SCRIPT_DIR/Containerfile.pi"
readonly IMAGE_TAG="${1:-${PI_IMAGE_TAG:-$DEFAULT_IMAGE_TAG}}"

build_context=''

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM

    if [[ -n "$build_context" && -d "$build_context" ]]; then
        rmdir "$build_context" 2>/dev/null || true
    fi

    exit "$exit_code"
}

validate_image_tag() {
    local image_tag=$1
    local registry=${image_tag%%/*}

    [[ "$image_tag" == */* && "$image_tag" != *[[:space:]]* ]] \
        || die 'Use a fully qualified image tag such as localhost/pi-agent-fedora:44 or docker.io/example/pi-agent-fedora:44.'

    [[ "$registry" == 'localhost' || "$registry" == *.* || "$registry" == *:* ]] \
        || die 'The image tag must include an explicit registry such as localhost or docker.io.'
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

(( $# <= 1 )) || die 'Usage: build-pi-image.sh [fully-qualified-image-tag]'
command -v podman >/dev/null 2>&1 || die 'Podman is required but was not found.'
[[ -f "$CONTAINERFILE" ]] || die "Containerfile not found: $CONTAINERFILE"
validate_image_tag "$IMAGE_TAG"

# Use an empty build context so project files and credentials can never be sent
# to the image build. The Containerfile does not COPY any host content.
build_context="$(mktemp --directory)"

printf 'Building %s from the official Fedora 44 image...\n' "$IMAGE_TAG"
podman build \
    --pull=always \
    --tls-verify=true \
    --tag "$IMAGE_TAG" \
    --file "$CONTAINERFILE" \
    "$build_context"

preinstalled_label="$(
    podman image inspect \
        --format '{{ index .Config.Labels "io.pi-agent.preinstalled" }}' \
        "$IMAGE_TAG"
)"
[[ "$preinstalled_label" == "$PREINSTALLED_LABEL_VERSION" ]] \
    || die 'The built image is missing its Pi compatibility label.'

printf '\nBuilt image: %s\n' "$IMAGE_TAG"
printf 'Run it through pi.sh with:\n'
printf '  PI_IMAGE=%q ./pi.sh\n' "$IMAGE_TAG"

if [[ "${IMAGE_TAG%%/*}" == 'localhost' ]]; then
    printf '\nTo publish it later, give it your registry tag first:\n'
    printf '  podman tag %q docker.io/your-user/pi-agent-fedora:44\n' "$IMAGE_TAG"
    printf '  podman push --tls-verify=true docker.io/your-user/pi-agent-fedora:44\n'
else
    printf '\nTo publish it later, authenticate, then run:\n'
    printf '  podman push --tls-verify=true %q\n' "$IMAGE_TAG"
fi
