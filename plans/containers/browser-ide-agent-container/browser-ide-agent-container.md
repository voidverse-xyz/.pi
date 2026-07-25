# Browser IDE agent container pattern

## Purpose

Build a persistent browser IDE that contains one or more terminal coding agents while keeping each workspace isolated from unrelated host state. Pair the image with a small host launcher that maps a selected project, starts the service detached, waits for readiness, and prints a loopback URL.

## Image pattern

1. Pin the browser IDE artifact, language runtime base, and agent package versions.
2. Prefer digest-pinned multi-architecture base images.
3. If the upstream IDE image contains sudo, setuid UID helpers, or broad tooling, copy only its application artifacts into a minimal final runtime.
4. Install agent CLIs with lifecycle scripts disabled when supported.
5. Run the final entrypoint and terminals as a stable non-root UID/GID.
6. Use a minimal init as PID 1.
7. Set a restrictive umask before the IDE creates its first authentication file.
8. Keep IDE configuration, IDE data/extensions, and each agent’s state in separate writable mount points.
9. Reserve `/workspace` for a container-owned sandbox. Mirror explicit host paths under `/host<absolute-path>` so nested and additional paths retain predictable locations.
10. Probe a documented unauthenticated health endpoint without weakening normal editor authentication.

## Privacy defaults

- Disable IDE telemetry, crash reporting, automatic update checks, experiments, tips, automatic extension updates, recommendations, Git auto-fetch, and automatic port forwarding where verified settings exist.
- Set a general do-not-track environment default.
- Disable each agent’s documented telemetry, analytics, feedback, raw-prompt export, OTEL exporters, update checks, and automatic startup network checks.
- Keep model-provider calls available as explicit functional traffic.
- Explain that third-party extensions and packages can implement independent telemetry.
- Do not pass passwords through image layers, URLs, labels, command arguments, or inspectable runtime environment variables.

## Launcher pattern

Use a dependency-free host launcher with a container-engine adapter.

1. Resolve the workspace canonically.
2. Build a full SHA-256 identity from a schema version, mode, and canonical path or sandbox name.
3. Store the full identity in container and volume labels; use only a short suffix in object names.
4. Lock per identity before discovery or lifecycle mutations.
5. Look for an existing identity across supported engines before choosing a default engine.
6. Reuse a healthy running container, restart a stopped compatible container, or create one when absent.
7. Compare immutable image IDs and a runtime-spec hash before reuse.
8. Replace stale containers transactionally while retaining deterministic named volumes.
9. Publish a fixed internal port to an engine-assigned high host port explicitly bound to `127.0.0.1`.
10. Inspect structured port data and reject wildcard or ambiguous bindings.
11. Poll the host-published health endpoint before printing the URL.
12. Verify PID 1 is non-root, has zero effective capabilities, and has `NoNewPrivs` enabled.
13. Make browser opening optional and non-fatal.
14. Define stop as retaining the container and volumes, and remove as deleting only the container. Volume deletion must be a separate explicit operation.

## Mount and device safety

- Reject host `/`, system and pseudo-filesystems, the whole home directory, credential/configuration trees, and parent mounts containing protected state.
- Reject control characters and compact-volume-syntax delimiters in paths, or use a structured mount API.
- Reduce duplicate/nested mount roots before relabeling.
- On SELinux hosts, use a private label for the primary project and a shared label only for explicit extras that may be reused.
- Never disable SELinux separation.
- Reject block devices. Prefer a strict allowlist of narrow character devices and require confirmation.
- Never mount container-engine sockets, SSH/GPG agents, browser profiles, or broad host runtime directories.

## Runtime confinement

Align launcher and Compose settings:

- non-root image user;
- all capabilities dropped;
- `no-new-privileges`;
- read-only root filesystem;
- bounded writable tmpfs mounts;
- default seccomp policy or a tested project profile;
- private PID and IPC namespaces;
- normal bridge networking, never host networking;
- loopback-only dynamic publication;
- explicit PID, memory, and CPU limits;
- no privileged mode or engine socket.

Use rootless user-namespace mapping for writable host projects. Never repair host bind permissions with recursive ownership or broad mode changes.

## Verification

Automate at least:

1. image build on every supported architecture;
2. exact runtime and agent versions;
3. non-root PID 1 and terminals;
4. zero capabilities and `NoNewPrivs`;
5. read-only root with all declared state paths writable;
6. authenticated editor and unauthenticated health route;
7. high loopback-only dynamic ports and concurrent collision-free instances;
8. correct sandbox and mirrored-host working directories;
9. host edit round trips;
10. independent IDE and agent state persistence;
11. stop/restart and remove/recreate behavior;
12. no credentials in image history, inspect output, URLs, arguments, logs, or docs;
13. telemetry/privacy settings for the IDE and every installed agent;
14. safe cleanup that cannot touch pre-existing user containers or volumes.

Publish only the exact image digest that passed the complete runtime test.
