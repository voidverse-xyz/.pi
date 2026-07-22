---
name: containerized-development
description: Develop inside Docker containers when Docker or Docker Compose is installed and available. Prefer containerized development over host tooling for local development work whenever Docker tooling is available, even if the needed host tools are also installed. Use a Dockerfile + docker compose (with `docker compose watch` for live sync/reload), bind-mount or sync the project source, keep Docker artifacts/state in a project `.docker/` dir, and install dependencies and run dev work inside the container.
---

# Containerized development

**Use this skill when Docker or Docker Compose is installed and available.** If
Docker tooling is available, switch to containerized development instead of using
host runtimes, package managers, compilers, test runners, or project
dependencies directly.

Before using Docker, check for available Docker tooling, for example with
`docker --version` and `docker compose version`. Prefer Compose when available.
If Docker is missing, unavailable, or not running, do not scaffold Docker files
as a workaround unless the user explicitly asks for Docker setup.

When this skill applies, keep the host clean: avoid installing language
runtimes, project dependencies, or build toolchains locally just to complete the
task. Everything for that project run should happen in the container; the host
provides Docker and an editor.

This applies to local dev work whenever Docker tooling is available — first-time
setup, running the app, builds, tests, and installing/updating dependencies. If
Docker is available and the Docker files don't exist yet, **scaffold them
first**, then proceed inside the container.

**Stack-agnostic.** This is not a Node.js convention — it applies to any
language or toolchain: C/C++ (gcc/clang, CMake, Make), Rust (cargo), Go, Python,
Java, Ruby, etc. "Dependencies," "build," and "dev server" mean whatever they
mean for the project's stack (compilers and headers, a build system, a compiled
binary, an interpreter, a long-running server — or just a CLI that builds and
exits). When this procedure applies, the rule is the same regardless: the
toolchain and build happen in the container, not on the host.

## The model

- **`Dockerfile`** — defines the dev image: base runtime, system packages, and a
  dependency-install step. This is where the toolchain lives.
- **`compose.yaml`** (aka `docker-compose.yml`) — defines the dev service(s):
  the build context, port mappings, env, and the **bind mount** of the project
  source into the container's working directory.
- **`docker compose watch`** — the preferred dev loop. It syncs source changes
  into the running container (and rebuilds when dependency manifests change) so
  you edit on the host and the change takes effect in the container immediately.
  Plain `docker compose up` is the fallback when watch isn't configured.
- **An in-container reloader** (nodemon, `node --watch`, uvicorn `--reload`,
  `air`, `cargo watch`, …) — the second half of the loop. `watch` gets the
  *files* into the container; the reloader restarts the *process* so they take
  effect. See "Live reload" below — this is the nodemon-style auto-update.

## Procedure

1. **Check whether this skill applies.** If Docker or Docker Compose is
   available, use this procedure instead of host tools. Prefer Compose when it is
   available.
2. **Check for Docker files.** If `Dockerfile` and a compose file are absent,
   scaffold them (see below) before doing containerized work.
3. **Build the image.** `docker compose build` (or let `up` build on first run).
4. **Bring it up.** Prefer `docker compose watch`; fall back to
   `docker compose up`.
5. **Install dependencies inside the container** for this procedure. Either bake
   the install into the `Dockerfile`, or run it in the running container:
   `docker compose exec <service> <install command>`. Adding a dependency means
   updating the manifest and reinstalling **in the container**, then letting the
   image rebuild.
6. **Run project commands in the container** — dev server, builds, tests, REPLs,
   one-off scripts — via the container (see below).

## Live reload: `docker compose watch` + an in-container reloader

Auto-update is **two layers**, and both must be present or edits won't take effect:

1. **Get the file into the container** — `docker compose watch` syncs the changed
   host file into the running container (it does *not* need a bind mount; sync
   copies the file in).
2. **Restart the process so it picks up the file** — a running `node`/`python`/
   compiled server won't notice a swapped file on its own. Either a process-level
   reloader inside the container restarts it (nodemon-style), or watch restarts the
   whole container for you. Pick **one** of these per service.

### The `develop.watch` actions

In `compose.yaml`, each service gets a `develop.watch` list. Each entry has a
`path` (host), an `action`, and usually a `target` (container path) and `ignore`:

- **`sync`** — copy changed files into the running container. The file lands, but
  the process is unchanged — so this **only auto-updates if something inside the
  container is watching and restarting**, i.e. a nodemon-style reloader (or a
  framework with built-in HMR like Vite/Next). This is the classic combo.
- **`sync+restart`** — sync the file **and restart the container's main process**.
  No in-container reloader needed — Compose itself is your "nodemon." Best for
  config files, or any service whose entrypoint starts fresh quickly. Restarts the
  container, does **not** rebuild the image.
- **`sync+exec`** — sync, then run a command in the container (Compose ≥ v2.32).
  Good for "file changed → run a migration / regenerate" without a full restart.
- **`rebuild`** — rebuild the image and recreate the container. Use for dependency
  manifests (`package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`) and the
  `Dockerfile` itself — anything that changes the image, not just source.

A typical Node service uses two entries: `sync` on the source dir (nodemon
restarts the process) and `rebuild` on `package.json`.

### Two valid setups — choose one

- **`sync` + a reloader in the container** (true nodemon-style): the container's
  command is the reloader (`nodemon`, `node --watch`, `tsx watch`, `uvicorn
  --reload`, `air`, `cargo watch -x run`, …). Fastest inner loop — only the app
  process restarts, the container keeps running. Preferred for an active dev loop.
- **`sync+restart`, no reloader**: simpler, no extra dev dependency; Compose
  restarts the whole container on each change. Slightly slower per change but
  nothing to configure inside the image. Good default when you don't want a
  reloader, or for non-Node stacks without a great one.

### The filesystem-events gotcha

A reloader watching synced/bind-mounted files inside a container sometimes misses
inotify events (common with bind mounts, and on macOS/Windows hosts). If saves
don't trigger a restart, switch the reloader to **polling**:

- **nodemon:** `nodemon -L` (a.k.a. `--legacy-watch`).
- **chokidar-based** (Vite, webpack, many JS tools): env `CHOKIDAR_USEPOLLING=true`.
- **Python watchdog / uvicorn reload:** generally works; if not, use polling-based
  watchers (`watchmedo` `--debounce`/poll) or fall back to `sync+restart`.

Polling costs some CPU — only enable it if event-based watching actually fails.

### Running it

`docker compose watch` (or `docker compose up --watch` to see app logs and watch
in one terminal). Edit a file on the host → watch syncs it → the reloader (or
`sync+restart`) restarts the process → the change is live.

**Concrete, copy-pasteable per-stack configs** (Node/nodemon, Vite, Python/uvicorn,
Go/air, Rust/cargo-watch) live in `reference.md` — read it when scaffolding watch
for a specific stack.

## Running commands: `exec` vs `run`

Both run a command in the container; pick by whether the service is already up.

- **`docker compose exec <service> <command>`** — runs inside the
  **already-running** container started by `up`/`watch`. Use this for the normal
  dev loop (tests, shells, scripts) while the stack is up. Fails if the service
  isn't running.
- **`docker compose run --rm <service> <command>`** — spins up a **fresh one-off**
  container, runs the command, and removes it (`--rm`). Use when nothing is
  running yet, or for isolated tasks (a migration, a single test run, a throwaway
  shell). Note it does **not** publish the service's ports by default — add
  `--service-ports` if you need them.
- Prefer the compose forms over raw `docker exec <container> ...`, which needs the
  container name/ID instead of the **service name** from `compose.yaml`.

## Scaffolding when files are missing

Create a minimal, stack-appropriate `Dockerfile` and `compose.yaml`:

- `Dockerfile`: pick a base image matching the project's runtime, set a working
  directory, copy the dependency manifest(s), run the install step, then copy the
  rest of the source.
- `compose.yaml`: define the dev service with `build: .`, the relevant published
  ports, env, and a `develop.watch` block for `docker compose watch` — `sync` the
  source path and `rebuild` on changes to the dependency manifest (see "Live
  reload" above and `reference.md` for full configs).
- **Dev command + reload strategy:** set the service `command` to a reloader
  (e.g. `nodemon`) paired with `action: sync`, *or* use `action: sync+restart` and
  a plain start command. Don't scaffold `sync` alone with a non-reloading command
  — files would sync but the app would never restart.

Keep it minimal and idiomatic for the stack. Confirm the runtime/version and
exposed ports from the project before generating, rather than guessing.

## Keep Docker stuff in a `.docker/` dir

Contain all Docker-related artifacts in a **`.docker/`** directory that lives at
the **root of each individual project** (one per project — not in your home dir
or any global location), instead of scattering them across the project root:

- Put supporting Docker config there — extra Dockerfiles, env files, init
  scripts, named-volume data, and any local Docker state the project generates.
- Point bind/named volumes at paths under `.docker/` (e.g. a database's data dir),
  so persisted container state lives in one predictable place.
- **Gitignore the data** under `.docker/` (volume contents, local env) while
  keeping the config files tracked. Never commit volume data or secrets.
- `Dockerfile` and `compose.yaml` can stay at the project root (tooling expects
  them there) and reference `.docker/` for the rest; or move them in and point
  `compose` at them — either is fine, just keep the *artifacts and state*
  corralled in `.docker/`.

## Clean up when done

Containers, images, and volumes accumulate and consume real disk. When finished
with a session or a project, tear down what you created:

- **Stop and remove the stack:** `docker compose down` removes the containers and
  the default network. Add `-v` (`docker compose down -v`) to **also remove named
  volumes** declared in the compose file — do this when you want a clean slate
  (e.g. resetting a dev database).
- **Remove the built image** when you no longer need it:
  `docker compose down --rmi local` (removes images built by this compose
  project), or `docker image rm <image>` for a specific one.
- **Prune dangling/old artifacts** periodically: `docker image prune` (dangling
  images), `docker container prune` (stopped containers), `docker volume prune`
  (unused volumes). `docker system prune` does all of these at once; add
  `--volumes` to include unused volumes and `-a` to also remove unused (not just
  dangling) images.
- **Careful with `-v` / `--volumes` and `prune`** — they delete persisted data
  (databases, caches). Only run them when you actually want that state gone. Data
  you keep under `.docker/` makes it obvious what's about to disappear.

## Why

- The host machine stays free of per-project runtimes and dependencies — no
  version conflicts, no global pollution, trivially reproducible environments.
- The container is the single source of truth for "how this project runs," so it
  works the same on any machine and matches CI/production more closely.
- `docker compose watch` keeps the edit-on-host / run-in-container loop fast.

## Don't

- Don't use this skill when Docker is missing, unavailable, or not running.
- Don't choose host tools over Docker just because the host tools are already
  installed.
- Once this procedure applies, don't install deps or toolchains **on the host** to
  "just get it working" — `npm install`, `pip install`, `cargo build`,
  `apt install g++`, `cmake`, `go mod download`, `bundle install`, etc. belong
  in the container.
- Once this procedure applies, don't run the dev server, compiler/build, or tests
  directly on the host.
- Once this procedure applies, don't skip scaffolding the Docker files and develop
  locally as a shortcut — set the container up first.
