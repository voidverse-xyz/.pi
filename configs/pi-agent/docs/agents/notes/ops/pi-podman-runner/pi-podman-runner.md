# Pi Podman Runner

The workspace-root `pi.sh` launches Pi Coding Agent inside an ephemeral Fedora
container. Generic reusable runner files are kept under
`configs/podman/pi-agent-container/` and `configs/podman/pi-agent-image/`.

## Runtime design

- Pull Fedora 44 from the Fedora Project's documented `quay.io/fedora/fedora`
  namespace with TLS verification enabled.
- Mount the caller's current directory read/write at `/workspace`. The runner
  disables SELinux label separation for the credential-bearing container and
  does not relabel any bind mount. This preserves the host labels on credential
  files and avoids Podman's refusal to relabel a user's home root. When the
  current directory is the user's home root, the runner warns that the entire
  home directory is exposed.
- Bind-mount Pi's host `~/.pi/agent/auth.json` read/write at the same container
  path so logins and OAuth refreshes survive container removal. If it is absent,
  the runner creates an empty owner-only store and directs the user to `/login`.
- Do not mount Codex or Claude Code configuration. Pi receives only its own
  `auth.json`, which can contain separate provider entries such as
  `openai-codex` and `anthropic`.
- Use Podman's `keep-id` user namespace so Pi writes project files with the
  invoking user's UID and GID.
- Install Fedora's `fd-find` and `ripgrep` packages along with Node.js, tmux,
  Git, and
  `@earendil-works/pi-coding-agent` inside the new container. npm lifecycle
  scripts are disabled, following Pi's install guidance. Installing `fd` and
  `rg` system-wide prevents Pi from downloading ephemeral copies at startup.
- Start Pi in the first tmux window with `/workspace` as its working directory.

## Prebuilt image

`build-pi-image.sh` builds `Containerfile.pi` as
`localhost/pi-agent-fedora:44` by default. It uses an empty build context, so
the project and mounted credentials cannot be copied into the image. The image
contains Pi and its system dependencies and carries the versioned
`io.pi-agent.preinstalled=2` compatibility label. Version 2 includes `fd` and
`ripgrep`; older prebuilt images must be rebuilt before this runner accepts
them.

The builder accepts a fully qualified alternative tag, including a future
Docker Hub destination:

```bash
./build-pi-image.sh docker.io/your-user/pi-agent-fedora:44
```

The runner automatically uses the default local prebuilt image when it exists.
Set `PI_IMAGE` to use another local or remote image. Remote images are pulled
with TLS verification, and the compatibility label is checked before launch:

```bash
PI_IMAGE=docker.io/your-user/pi-agent-fedora:44 ./pi.sh
```

Publishing remains an explicit user action with `podman push`; neither script
logs into a registry or uploads an image.

## Lifecycle

The container runs detached behind the interactive `podman exec` session. When
Pi/tmux exits, or when the wrapper receives Ctrl+C, the user is asked whether to
keep the container running. The default response removes it. Keeping it prints a
command for opening another shell in the mounted workspace.

The prompt also runs after a normal interactive-session exit because Pi and
Podman use a raw TTY: Pi consumes Ctrl+C twice to quit, so the host shell does
not reliably receive that keypress as a signal.

## Credential migration

A temporary workspace-root `auth.json` may be used to transfer Pi provider
credentials to another host. The root path is ignored by Git. Keep the file at
mode `0600`, copy it to the destination user's `~/.pi/agent/auth.json`, and
delete the transfer copy afterward.

Mapping a Claude Code OAuth record into Pi is structurally compatible when both
installed clients use the same Anthropic OAuth client. It still duplicates a
rotating refresh token: do not use the source and mapped copies concurrently,
and prefer a fresh Pi `/login` for long-term independent use.

## Validation

The runner was checked with `bash -n` and an argument-capturing Podman mock for
both a project working directory and a home-root working directory. It was also
smoke-tested end to end: Podman pulled the Fedora image, Pi 0.80.10 installed,
`fd` and `rg` resolved from `/usr/bin` without Pi fallback downloads, the
existing Pi/OpenAI login was recognized in the TUI, the host credential labels
remained unchanged, and the default lifecycle removed the test container.
