#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: run_claude.sh [--workdir DIR] [--] PROMPT...

Runs Claude Code in non-interactive mode and prepends an instruction to read
AGENTS.md/agents.md/Agents.md at the project level or home user level before
doing work.

If PROMPT is omitted, the task prompt is read from stdin.
USAGE
}

workdir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --workdir)
      if [[ $# -lt 2 ]]; then
        echo "error: --workdir requires a directory" >&2
        exit 2
      fi
      workdir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

if [[ -n "$workdir" ]]; then
  cd "$workdir"
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "error: claude CLI not found on PATH" >&2
  exit 127
fi

if [[ $# -gt 0 ]]; then
  task="$*"
elif [[ ! -t 0 ]]; then
  task="$(cat)"
else
  usage
  exit 2
fi

if [[ -z "${task//[[:space:]]/}" ]]; then
  echo "error: prompt is empty" >&2
  exit 2
fi

find_agents_file() {
  local dir parent name
  dir="$(pwd -P)"
  while true; do
    for name in AGENTS.md agents.md Agents.md; do
      if [[ -f "$dir/$name" ]]; then
        printf '%s\n' "$dir/$name"
        return 0
      fi
    done
    parent="$(dirname "$dir")"
    if [[ "$parent" == "$dir" ]]; then
      break
    fi
    dir="$parent"
  done

  if [[ -n "${HOME:-}" ]]; then
    for name in AGENTS.md agents.md Agents.md; do
      if [[ -f "$HOME/$name" ]]; then
        printf '%s\n' "$HOME/$name"
        return 0
      fi
    done
  fi

  return 1
}

agents_file="$(find_agents_file || true)"
if [[ -n "$agents_file" ]]; then
  prefix="Before doing any work, read and follow this AGENTS.md/agents.md instruction file from the project level or home user level: $agents_file. If it conflicts with the task, identify the conflict and follow higher-priority instructions."
else
  prefix="No AGENTS.md, agents.md, or Agents.md file was found at the project level by walking upward from $(pwd -P), or at the home user level under ${HOME:-<unset>}. State that no project-level or home-level instruction file was found, then proceed with the task."
fi

claude -p "$prefix

Task:
$task"
