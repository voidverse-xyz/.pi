#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

# Fedora's official downloads page publishes this fully qualified image. Pin the
# release instead of relying on a mutable "latest" tag, and verify registry TLS.
readonly FEDORA_IMAGE="quay.io/fedora/fedora:44"
readonly DEFAULT_BUILT_IMAGE="localhost/pi-agent-fedora:44"
readonly PI_PACKAGE="@earendil-works/pi-coding-agent"
readonly PREINSTALLED_LABEL_VERSION="2"
readonly CONTAINER_WORKDIR="/workspace"
readonly CONTAINER_HOME="/home/pi-user"
readonly CONTAINER_PI_CREDENTIALS="$CONTAINER_HOME/.pi/agent/auth.json"
readonly CONTAINER_NAME="pi-agent-$(date +%s)-$$"

readonly HOST_UID="$(id -u)"
readonly HOST_GID="$(id -g)"
readonly HOST_HOME="$(cd -- "${HOME:?HOME must be set}" && pwd -P)"
readonly HOST_PI_CREDENTIALS="${PI_CODING_AGENT_DIR:-$HOST_HOME/.pi/agent}/auth.json"
readonly WORKSPACE="$(pwd -P)"

container_created=0
keep_container=0
keep_prompted=0
container_image="$FEDORA_IMAGE"
install_pi=1
pi_auth_created=0

die() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

validate_image_reference() {
    local image_reference=$1
    local registry=${image_reference%%/*}

    [[ "$image_reference" == */* && "$image_reference" != *[[:space:]]* ]] \
        || die 'PI_IMAGE must be fully qualified, for example docker.io/example/pi-agent-fedora:44.'

    [[ "$registry" == 'localhost' || "$registry" == *.* || "$registry" == *:* ]] \
        || die 'PI_IMAGE must include an explicit registry such as localhost or docker.io.'
}

cleanup() {
    local exit_code=$?

    trap - EXIT INT TERM

    if ((container_created == 1 && keep_container == 0)); then
        printf 'Removing container %s...\n' "$CONTAINER_NAME"
        podman rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
    fi

    exit "$exit_code"
}

prompt_to_keep_container() {
    local reply=''

    if ((container_created == 0 || keep_prompted == 1)); then
        return
    fi

    keep_prompted=1

    printf 'Keep container %s running in the background? [y/N] ' \
        "$CONTAINER_NAME" >&2
    IFS= read -r reply || reply=''

    case "$reply" in
        y | Y | yes | YES | Yes)
            keep_container=1
            printf 'Container %s is still running.\n' "$CONTAINER_NAME"
            printf 'Re-enter it with:\n'
            printf '  podman exec -it --user %s:%s --env HOME=%s --workdir %s %s /bin/bash\n' \
                "$HOST_UID" "$HOST_GID" "$CONTAINER_HOME" \
                "$CONTAINER_WORKDIR" "$CONTAINER_NAME"
            ;;
        *)
            printf 'The container will be removed.\n'
            ;;
    esac
}

on_interrupt() {
    printf '\nCtrl+C detected.\n' >&2
    prompt_to_keep_container
    exit 130
}

on_terminate() {
    printf '\nTermination requested.\n' >&2
    exit 143
}

trap cleanup EXIT
trap on_interrupt INT
trap on_terminate TERM

command -v podman >/dev/null 2>&1 || die 'Podman is required but was not found.'
[[ -t 0 && -t 1 ]] || die 'Run this script from an interactive terminal.'
[[ "$HOST_PI_CREDENTIALS" == /* ]] \
    || die "Pi's credential path must be absolute: $HOST_PI_CREDENTIALS"

if [[ ! -e "$HOST_PI_CREDENTIALS" ]]; then
    mkdir -p -- "${HOST_PI_CREDENTIALS%/*}" \
        || die "Could not create Pi's credential directory: ${HOST_PI_CREDENTIALS%/*}"
    chmod 0700 "${HOST_PI_CREDENTIALS%/*}" \
        || die "Could not secure Pi's credential directory: ${HOST_PI_CREDENTIALS%/*}"
    printf '{}\n' >"$HOST_PI_CREDENTIALS" \
        || die "Could not create Pi's credential file: $HOST_PI_CREDENTIALS"
    chmod 0600 "$HOST_PI_CREDENTIALS" \
        || die "Could not secure Pi's credential file: $HOST_PI_CREDENTIALS"
    pi_auth_created=1
fi

[[ -f "$HOST_PI_CREDENTIALS" ]] \
    || die "Pi's credential path is not a regular file: $HOST_PI_CREDENTIALS"
[[ -r "$HOST_PI_CREDENTIALS" && -w "$HOST_PI_CREDENTIALS" ]] \
    || die "Pi's credentials are not readable and writable: $HOST_PI_CREDENTIALS"

if ((pi_auth_created == 1)); then
    printf 'Created an empty Pi credential store at %s. Use /login inside Pi once.\n' \
        "$HOST_PI_CREDENTIALS" >&2
fi

if [[ "$WORKSPACE" == "$HOST_HOME" ]]; then
    printf 'Warning: the current directory is your entire home directory: %s\n' \
        "$WORKSPACE" >&2
    printf 'The container will be able to access every file under your home directory.\n' >&2
fi

printf 'SELinux label separation is disabled so mounted host credential labels remain unchanged.\n' >&2

if [[ -n "${PI_IMAGE:-}" ]]; then
    validate_image_reference "$PI_IMAGE"
    container_image="$PI_IMAGE"
    install_pi=0

    if podman image exists "$PI_IMAGE"; then
        printf 'Using local prebuilt Pi image %s.\n' "$PI_IMAGE"
    elif [[ "${PI_IMAGE%%/*}" == 'localhost' ]]; then
        die "Local prebuilt image not found: $PI_IMAGE"
    else
        printf 'Pulling prebuilt Pi image %s...\n' "$PI_IMAGE"
        podman pull --tls-verify=true "$PI_IMAGE"
    fi
elif podman image exists "$DEFAULT_BUILT_IMAGE"; then
    container_image="$DEFAULT_BUILT_IMAGE"
    install_pi=0
    printf 'Using local prebuilt Pi image %s.\n' "$container_image"
else
    printf 'Pulling official Fedora image %s...\n' "$FEDORA_IMAGE"
    podman pull --tls-verify=true "$FEDORA_IMAGE"
fi

if ((install_pi == 0)); then
    preinstalled_label="$(
        podman image inspect \
            --format '{{ index .Config.Labels "io.pi-agent.preinstalled" }}' \
            "$container_image"
    )"
    [[ "$preinstalled_label" == "$PREINSTALLED_LABEL_VERSION" ]] \
        || die "Image is not compatible with this runner; rebuild it with the current Containerfile.pi: $container_image"
fi

printf 'Starting container %s from %s with %s mounted at %s...\n' \
    "$CONTAINER_NAME" "$container_image" "$WORKSPACE" "$CONTAINER_WORKDIR"
podman run --detach \
    --pull=never \
    --name "$CONTAINER_NAME" \
    --hostname pi-agent \
    --userns=keep-id \
    --user 0:0 \
    --security-opt label=disable \
    --volume "$WORKSPACE:$CONTAINER_WORKDIR:rw" \
    --volume "$HOST_PI_CREDENTIALS:$CONTAINER_PI_CREDENTIALS:rw" \
    --workdir "$CONTAINER_WORKDIR" \
    "$container_image" \
    sleep infinity >/dev/null
container_created=1

if ((install_pi == 1)); then
    printf 'Installing fd, ripgrep, Node.js, tmux, Git, and Pi inside the container...\n'
else
    printf 'Pi and its dependencies are already installed in the image.\n'
fi

printf 'Preparing the container user and Pi credential path...\n'
podman exec \
    --env "HOST_UID=$HOST_UID" \
    --env "HOST_GID=$HOST_GID" \
    --env "CONTAINER_HOME=$CONTAINER_HOME" \
    --env "PI_PACKAGE=$PI_PACKAGE" \
    --env "INSTALL_PI=$install_pi" \
    "$CONTAINER_NAME" \
    /bin/bash -Eeuo pipefail -c '
        if [[ "$INSTALL_PI" == 1 ]]; then
            dnf --assumeyes install \
                ca-certificates \
                fd-find \
                git \
                nodejs \
                npm \
                ripgrep \
                shadow-utils \
                tmux

            npm install \
                --global \
                --ignore-scripts \
                --registry=https://registry.npmjs.org \
                "$PI_PACKAGE"

            dnf clean all
        fi

        if ! getent group "$HOST_GID" >/dev/null; then
            groupadd --gid "$HOST_GID" pi-agent
        fi

        if ! getent passwd "$HOST_UID" >/dev/null; then
            useradd \
                --uid "$HOST_UID" \
                --gid "$HOST_GID" \
                --home-dir "$CONTAINER_HOME" \
                --shell /bin/bash \
                --no-create-home \
                pi-agent
        fi

        install \
            --directory \
            --owner "$HOST_UID" \
            --group "$HOST_GID" \
            --mode 0750 \
            "$CONTAINER_HOME"

        install \
            --directory \
            --owner "$HOST_UID" \
            --group "$HOST_GID" \
            --mode 0700 \
            "$CONTAINER_HOME/.pi/agent"

        command -v fd
        command -v rg
        command -v pi
        pi --version
    '

printf 'Opening Pi in tmux at %s...\n' "$CONTAINER_WORKDIR"
printf 'Inside Pi, Ctrl+C twice quits. Detach tmux with Ctrl+B, then D.\n'

session_status=0
podman exec --interactive --tty \
    --user "$HOST_UID:$HOST_GID" \
    --env "HOME=$CONTAINER_HOME" \
    --env "TERM=xterm-256color" \
    --env "COLORTERM=${COLORTERM:-truecolor}" \
    --workdir "$CONTAINER_WORKDIR" \
    "$CONTAINER_NAME" \
    /bin/bash --noprofile --norc -c \
    'cd /workspace
     pi_bin="$(command -v pi)"
     exec tmux -u new-session -A -s pi -n pi -c /workspace "$pi_bin"' \
    || session_status=$?

# Pi and Podman use a raw TTY, so Ctrl+C is normally consumed inside Pi before
# the host shell sees it. Prompt whenever that interactive session ends; this
# covers Ctrl+C twice, /quit, errors, and a deliberate tmux detach.
prompt_to_keep_container

exit "$session_status"
