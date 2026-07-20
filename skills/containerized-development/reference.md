# `docker compose watch` — concrete configs

Copy-pasteable setups for live reload inside a container. Each pairs a
`develop.watch` block with a reload strategy. Adjust ports, paths, and base image
versions to the project. See `SKILL.md` → "Live reload" for the concepts.

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

**Dockerfile**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 3000
CMD ["npx", "nodemon", "--watch", "src", "src/index.js"]
# Bind mounts / some hosts miss inotify events — if saves don't reload, use:
# CMD ["npx", "nodemon", "-L", "--watch", "src", "src/index.js"]
```

**compose.yaml**

```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
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
```

Run: `docker compose watch` (or `docker compose up --watch` to tail app logs too).

**No-nodemon variant:** drop nodemon, set `CMD ["node", "src/index.js"]`, and
change the source entry to `action: sync+restart`. Compose restarts the container
on each save. Or use Node's built-in watcher: `CMD ["node", "--watch", "src/index.js"]`
with `action: sync`. TypeScript: `tsx watch src/index.ts` or `ts-node-dev`.

---

## Vite / React / webpack dev server (HMR)

The dev server has its own watcher and HMR — `watch` just needs to deliver files.
Chokidar (Vite/webpack) often misses container FS events, so enable polling.

```yaml
services:
  web:
    build: .
    command: npm run dev -- --host 0.0.0.0   # bind to 0.0.0.0 so the host can reach it
    ports:
      - "5173:5173"
    environment:
      CHOKIDAR_USEPOLLING: "true"   # makes file watching reliable in containers
    develop:
      watch:
        - path: ./src
          action: sync
          target: /app/src
          ignore: [node_modules/]
        - path: ./package.json
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
      - "8000:8000"
    develop:
      watch:
        - path: ./app
          action: sync
          target: /app/app
        - path: ./requirements.txt
          action: rebuild
```

Flask: `flask --app app run --debug --host 0.0.0.0` auto-reloads the same way.
Django's `runserver` auto-reloads too. If a reloader misses events, fall back to
`action: sync+restart` and a plain `command`.

---

## Go + air

`air` (or `CompileDaemon`) rebuilds and reruns the binary on change inside the
container; `sync` delivers the `.go` files.

```dockerfile
FROM golang:1.23
WORKDIR /app
RUN go install github.com/air-verse/air@latest
COPY go.mod go.sum ./
RUN go mod download
COPY . .
EXPOSE 8080
CMD ["air"]
```

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    develop:
      watch:
        - path: .
          action: sync
          target: /app
          ignore: [tmp/, .git/]
        - path: ./go.mod
          action: rebuild
```

---

## Rust + cargo-watch

```dockerfile
FROM rust:1
WORKDIR /app
RUN cargo install cargo-watch
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main(){}" > src/main.rs && cargo build && rm -rf src
COPY . .
EXPOSE 8080
CMD ["cargo", "watch", "-x", "run"]
```

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    develop:
      watch:
        - path: ./src
          action: sync
          target: /app/src
        - path: ./Cargo.toml
          action: rebuild
```

Rust recompiles are slow; `sync+restart` is usually not worth it here — keep the
`cargo watch` process resident so it reuses the incremental build cache.

---

## Decision cheat-sheet

| You want…                                   | Use                                      |
|---------------------------------------------|------------------------------------------|
| Fastest loop, process restarts only         | `sync` + in-container reloader (nodemon) |
| Simplest, no extra dev dep                   | `sync+restart`, plain start command      |
| Dependency / Dockerfile change picked up     | `rebuild` on the manifest                |
| Run a migration etc. on change               | `sync+exec` (Compose ≥ v2.32)            |
| Saves don't trigger a reload                 | enable polling (`nodemon -L`, `CHOKIDAR_USEPOLLING=true`) |
