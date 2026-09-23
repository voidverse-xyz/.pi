---
name: containerized-development
description: Design, add, or use Docker/Compose development environments. Use when the user explicitly asks for containers, when the repository already uses Docker as its supported development path, or when project instructions require containerized tooling. Do not introduce Docker merely because it is installed; preserve an existing host, devcontainer, Nix, or CI workflow unless the user chooses a migration.
---

# Containerized Development

Use containers as a project decision, not an automatic preference. Docker being
installed proves only that it is available; it does not authorize adding Docker
files, replacing a working development workflow, or starting services.

This skill is host-platform-neutral. Adapt commands, paths, quoting, file-sharing,
and wrapper scripts to the active environment (Windows/PowerShell or `cmd.exe`,
macOS, Linux/Unix, WSL, CI, or a remote workspace). Docker host platform and
container OS are separate: do not apply Linux-container commands to Windows
containers, or vice versa. The bundled examples explicitly target Linux
containers and are not universal templates.

## Decide whether this skill applies

Use it when at least one condition is true:

- The user requests Docker, Compose, a dev container, or container debugging.
- Repository instructions identify containers as the supported workflow.
- Existing `Dockerfile*`, `compose.y*ml`, `.devcontainer/`, or task scripts show
  that the requested work is meant to run in containers.

If the repository has no container workflow, first inspect its documented setup.
Offer containerization when it provides a concrete benefit, then wait for the
user to choose it before scaffolding tracked files.

## Inspect before acting

1. Read repository instructions and setup documentation.
2. Inspect existing Docker, Compose, devcontainer, CI, and ignore files.
3. When a Docker operation is needed, check the available engine/CLI, active
   context, daemon connectivity, container OS, architecture, and Compose version.
   Docker Desktop, remote contexts, WSL integration, and compatible alternative
   engines can differ materially.
4. Identify the actual runtime versions, dependency lockfiles, services, ports,
   environment variables, CPU architecture, host platform, and network/offline
   constraints.
5. Check version-control status when the repository and tooling support it, and
   preserve unrelated or user-authored work.

Prefer established entry points over raw Compose commands: project wrappers,
package scripts, Gradle/Maven wrappers, PowerShell or command scripts, `make`,
`just`, or other task runners. Detect what exists rather than assuming a Unix
shell or `make` is available.

## Use the smallest sufficient workflow

### Existing container workflow

Follow it. Reuse service names, profiles, volumes, health checks, and documented
commands. Do not regenerate working configuration to match this skill.

For one-off commands:

- Use `docker compose exec <service> <command>` when the service is running.
- Use `docker compose run --rm <service> <command>` for an isolated task.
- Use the project's wrapper command when one exists.

### New container workflow

First classify the workload: long-running web service, CLI/batch job, worker,
database, desktop/GUI app, GPU or architecture-specific job, cross-compiler,
monorepo, or CI-only task. Derive service lifetime, mounts, ports, devices,
reload behavior, and verification from that workload; many containers need no
published port or live-reload loop.

After the user chooses containerization, create only what the project needs:

- A development `Dockerfile` with a runtime version derived from the project.
- A `compose.yaml` when multiple services, ports, environment, or volumes justify
  it; a plain `docker build`/`docker run` flow may be sufficient otherwise.
- A `.dockerignore` that excludes VCS data, dependency caches, build output,
  secrets, and local state without excluding required build inputs.
- Documentation for build, run, test, reset, and troubleshooting commands.

Keep conventional root filenames unless the repository already centralizes
support files elsewhere. Do not impose a `.docker/` directory or host-mounted
state layout on projects with a different convention.

## Secure and reproducible defaults

- Select a project-compatible image version. A major/minor tag is a compatibility
  constraint, not an immutable pin; use a patch tag or digest when reproducible
  bytes are required. Do not use `latest` or install unpinned global tools at
  container start.
- Install dependencies from lockfiles and preserve the package manager's frozen
  or reproducible mode.
- Run the application as a non-root user when practical. Verify bind-mounted
  files remain writable without broadening permissions indiscriminately. Numeric
  UID/GID mapping is primarily a Linux-host concern; Docker Desktop and Windows
  containers have different ownership models.
- Pass secrets at runtime through the repository's established secret mechanism.
  Never bake them into image layers, Compose files, build arguments, or logs.
- Expose only required ports and bind to loopback by default unless LAN access is
  explicitly needed.
- Add health checks when service readiness matters; dependency start order alone
  is not readiness.
- Verify image and tool support for the host/container architecture. Do not force
  a `platform` value unless slower emulation or cross-building is deliberate.
- Keep production and development concerns separate. Do not claim a development
  image is production-ready without reviewing image size, privileges, secrets,
  entrypoint behavior, and supply-chain requirements.

## Source sync and reload

Choose one source-update strategy per service:

- **Bind mount:** simplest when host/container filesystem behavior is reliable.
- **Compose watch:** useful when sync performs better than bind mounts or when
  manifest changes should trigger rebuilds.
- **Rebuild/recreate:** appropriate for compiled artifacts or configuration that
  cannot be reloaded safely.

File sync and process reload are separate concerns. Pair `sync` with an
in-container watcher/HMR process, use `sync+restart`, or rebuild as appropriate.
Do not add a watcher dependency unless the project needs a persistent dev loop.
If macOS/Windows filesystem events are unreliable, try the project's polling
option only after observing missed events because polling consumes extra CPU.

Before using Compose Watch, inspect `docker compose watch --help` and the action
support in the installed Compose version. Fall back to bind mounts, rebuilds, or
the project's existing watcher when unavailable.

When scaffolding stack-specific watch configuration, read `reference.md` and
adapt it to the installed Compose version and the project's existing scripts.
Treat examples as Linux-container web-service patterns, not copy-paste
requirements.

## Dependencies and generated files

Update dependency manifests and lockfiles through the same environment the
project documents. If that environment is the container, run the package manager
there and verify ownership of changed files. Compose Watch is one-way,
host-to-container sync: changes made only in a container's writable layer do not
update the host checkout. For dependency changes, use an approved task with the
source bind-mounted, or explicitly export the changed manifests and lockfiles to
a staging location and reconcile them with current host files before replacing
anything. Verify the host diff and ownership before recreating the container;
then rebuild from those verified host inputs. Apply the same rule to generated
source files that must survive container removal. Do not copy back the entire
container tree or overwrite concurrent host edits.

Avoid anonymous dependency volumes that silently mask host files unless the
repository deliberately uses them.

For local development databases, named volumes are often safer than host bind
mounts. Preserve the established storage policy for ephemeral tests, CI, remote
engines, externally managed databases, and non-local workloads. Bind-mount
database storage only when the image and host filesystem support it.

## Verification

Run the narrowest checks that prove the requested work:

1. Validate configuration with `docker compose config` when Compose is used.
2. Build the affected image without relying on stale local layers when diagnosing
   reproducibility problems.
3. Start only required services and wait for actual readiness.
4. Run the project's targeted tests or command inside the intended service.
5. Confirm source updates/reload if the task changes the dev loop.
6. Review logs for permission errors, leaked secrets, crash loops, and unhealthy
   dependencies.
7. Report exact commands run and any host/platform limitation.

## Cleanup and destructive actions

Ordinary cleanup may stop and remove containers created for this task. Treat data
and shared-cache deletion as destructive:

- `docker compose down -v`
- `docker volume rm` / `docker volume prune`
- `docker system prune`, especially with `-a` or `--volumes`
- deleting bind-mounted state
- removing images or networks not clearly created for this task

Explain what will be deleted and obtain explicit confirmation immediately before
running those commands. Never prune the user's global Docker environment as
routine task cleanup.
