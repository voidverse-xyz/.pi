# Pi Podman container runner

Reusable wrapper pattern for launching Pi Coding Agent in an ephemeral Fedora container while keeping project files on the host.

## Runtime design

- Mount the caller's current directory at `/workspace` read/write.
- Bind only Pi's agent credential store into the same path inside the container; do not mount unrelated agent configs by default.
- Use Podman's `keep-id` user namespace so generated project files keep the invoking user's UID/GID.
- Install or use an image with Pi, Node.js, Git, tmux, `fd`, and `ripgrep` available in the container.
- Start Pi inside tmux with `/workspace` as the working directory.

## Prebuilt image

`../pi-agent-image/Containerfile.pi` and `../pi-agent-image/build-pi-image.sh` build a local Fedora-based image. The runner can use the local image when present, or a compatible image supplied through `PI_IMAGE`.

## Safety notes

- Treat mounted credential files as sensitive local runtime state; do not commit them.
- Avoid mounting an entire home directory unless the user explicitly accepts that exposure.
- Publishing a built image should remain an explicit user action.
