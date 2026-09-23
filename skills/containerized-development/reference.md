# Linux-container web-service examples for Compose Watch

These examples target Linux containers and web-service development. They are not
universal host or workload templates and do not apply unchanged to Windows
containers, CLI jobs, workers, GUI/GPU workloads, monorepos, or CI. Adapt shell
syntax, package manager, image, architecture, paths, ports, service lifetime, and
verification to the repository and active host. Replace every placeholder before
execution.

Check `docker compose version` and `docker compose watch --help` before using
`develop.watch`; actions vary by Compose release. Use bind mounts or explicit
rebuilds when Watch is unavailable. Paths below are illustrative, case-sensitive
Linux-container paths resolved from the Compose project directory. Review
`.dockerignore`, watch ignores, file-sharing permissions, line endings, symlinks,
and executable bits—especially on Windows and macOS.

Each setup pairs a `develop.watch` block with a reload strategy. Supply
project-compatible image and tool versions. See `SKILL.md` → "Source sync and
reload" for the concepts.

The general shape of a watch entry:

```yaml
develop:
  watch:
    - path: ./src          # host path to watch
      action: sync          # sync | sync+restart | sync+exec | rebuild
      target: /app/src      # container path (for sync/sync+exec)
      ignore:               # optional, host paths to skip
        - node_modules/
```

---

## Node.js + nodemon (classic nodemon-style auto-reload)

`sync` copies the changed file in; **nodemon** (running as the container command)
sees it and restarts the app process.

**Dockerfile (npm project with a committed lockfile)**

The image tag is illustrative, not immutable; use the repository's supported
version or digest. For pnpm, Yarn, npm without a lockfile, or a monorepo, use its
existing package-manager and workspace workflow instead of `npm ci`.

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]
# Define "dev" in package.json using the lockfile-installed nodemon.
# If saves do not reload, add nodemon's -L/--legacy-watch option there.
```

**compose.yaml**

```yaml
services:
  app:
    build: .
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      NODE_ENV: development
    develop:
      watch:
        - path: ./src
          action: sync
          target: /app/src
          ignore:
            - node_modules/
        - path: ./package.json     # dependency change → rebuild image
          action: rebuild
        - path: ./package-lock.json
          action: rebuild
        - path: ./Dockerfile
          action: rebuild
```

Run: `docker compose watch` (or `docker compose up --watch` to tail app logs too).

**No-nodemon variant:** drop nodemon, set `CMD ["node", "src/index.js"]`, and
change the source entry to `action: sync+restart`. Compose restarts the container
on each save. Or use Node's built-in watcher: `CMD ["node", "--watch", "src/index.js"]`
with `action: sync`. TypeScript: `tsx watch src/index.ts` or `ts-node-dev`.

---

## Vite / React / webpack dev server (HMR)

The dev server has its own watcher and HMR — `watch` must deliver all of its
inputs, not only `src`. The example below is specifically for Vite with
`index.html`, `public/`, and `vite.config.ts`: substitute the actual config path
and omit entries for absent optional files/directories. Include any additional
root/shared inputs used by the project. Other dev servers need their own flags,
ports, input inventory, and reload strategy; do not assume Vite flags apply.

If the project's watcher misses container filesystem events, enable its polling
option only after confirming missed updates; polling increases CPU usage.

```yaml
services:
  web:
    build: .
    command: npm run dev -- --host 0.0.0.0   # bind to 0.0.0.0 so the host can reach it
    ports:
      - "127.0.0.1:5173:5173"
    # If filesystem events are actually missed, opt into the project's polling
    # setting here; polling is not enabled by default because it costs CPU.
    develop:
      watch:
        - path: ./src
          action: sync
          target: /app/src
          ignore: [node_modules/]
        - path: ./index.html
          action: sync
          target: /app/index.html
        - path: ./public
          action: sync
          target: /app/public
        - path: ./vite.config.ts
          action: rebuild
        - path: ./package.json
          action: rebuild
        - path: ./package-lock.json
          action: rebuild
        - path: ./Dockerfile
          action: rebuild
```

Next.js is the same idea with `command: npm run dev` and port `3000`.

---

## Python + uvicorn / FastAPI (`--reload`)

uvicorn's `--reload` is the in-container reloader; `sync` feeds it files.

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
```

```yaml
services:
  api:
    build: .
    ports:
      - "127.0.0.1:8000:8000"
    develop:
      watch:
        - path: ./app
          action: sync
          target: /app/app
        - path: ./requirements.txt
          action: rebuild
        - path: ./Dockerfile
          action: rebuild
```

Flask: `flask --app app run --debug --host 0.0.0.0` auto-reloads the same way.
Django's `runserver` auto-reloads too. If a reloader misses events, fall back to
`action: sync+restart` and a plain `command`.

---

## Go + air

`air` (or `CompileDaemon`) rebuilds and reruns the binary on change inside the
container; `sync` delivers the `.go` files.

Set `GO_IMAGE` to the project-compatible pinned image and `AIR_VERSION` to an
explicit released version through Compose build args or CI. `AIR_VERSION` omits
the leading `v`. The placeholders below must be replaced before use. Image builds
also require authorized network or registry access unless the project supplies a
prebuilt development image:

```dockerfile
ARG GO_IMAGE
FROM ${GO_IMAGE}
ARG AIR_VERSION
RUN test -n "$AIR_VERSION"
WORKDIR /app
RUN go install github.com/air-verse/air@v${AIR_VERSION}
COPY go.mod go.sum ./
RUN go mod download
COPY . .
EXPOSE 8080
CMD ["air"]
```

```yaml
services:
  app:
    build:
      context: .
      args:
        GO_IMAGE: "golang:<project-pinned-version>"
        AIR_VERSION: "<project-pinned-version>"
    ports:
      - "127.0.0.1:8080:8080"
    develop:
      watch:
        - path: .
          action: sync
          target: /app
          ignore: [tmp/, .git/]
        - path: ./go.mod
          action: rebuild
        - path: ./go.sum
          action: rebuild
        - path: ./Dockerfile
          action: rebuild
```

---

## Rust + cargo-watch

Set `RUST_IMAGE` to the project-compatible pinned image and
`CARGO_WATCH_VERSION` to an explicit released version. The placeholders below
must be replaced before use. Image builds also require authorized network or
registry access unless the project supplies a prebuilt development image:

```dockerfile
ARG RUST_IMAGE
FROM ${RUST_IMAGE}
ARG CARGO_WATCH_VERSION
RUN test -n "$CARGO_WATCH_VERSION"
WORKDIR /app
RUN cargo install cargo-watch --version "${CARGO_WATCH_VERSION}" --locked
COPY . .
RUN cargo build --locked
EXPOSE 8080
CMD ["cargo", "watch", "-x", "run"]
```

```yaml
services:
  app:
    build:
      context: .
      args:
        RUST_IMAGE: "rust:<project-pinned-version>"
        CARGO_WATCH_VERSION: "<project-pinned-version>"
    ports:
      - "127.0.0.1:8080:8080"
    develop:
      watch:
        - path: ./src
          action: sync
          target: /app/src
        - path: ./Cargo.toml
          action: rebuild
        - path: ./Cargo.lock
          action: rebuild
        - path: ./Dockerfile
          action: rebuild
```

Build the real package, including build scripts and declared library/binary
inputs; a synthetic `src/main.rs` is not a safe dependency-cache substitute.
Exclude host `target/` artifacts through `.dockerignore`. Keep any added build
cache scoped to compatible toolchains/targets and verify it cannot mask changes.

Rust recompiles are slow; `sync+restart` is usually not worth it here — keep the
`cargo watch` process resident so it reuses the incremental build cache. Add watch
entries for build scripts or other inputs outside `src` when the project uses
them; `cargo watch` cannot see host files that were never synced or rebuilt.

---

## Decision cheat-sheet

| You want…                                   | Use                                      |
|---------------------------------------------|------------------------------------------|
| Fastest loop, process restarts only         | `sync` + in-container reloader (nodemon) |
| Simplest, no extra dev dep                   | `sync+restart`, plain start command      |
| Dependency / Dockerfile change picked up     | `rebuild` on the manifest                |
| Run a migration etc. on change               | `sync+exec` (Compose ≥ v2.32)            |
| Saves don't trigger a reload                 | enable polling (`nodemon -L`, `CHOKIDAR_USEPOLLING=true`) |
