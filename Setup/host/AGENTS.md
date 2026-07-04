# Home Agent Instructions

This is the home-level entry point for agents running from this home directory.

Before working, find the shared documents directory at `Agents/Documents/`
relative to this home directory, then read the shared agent context file there:

- `AGENTS.md`

Follow that shared context file for reusable agent materials and update guidance,
including sibling skills, MCP definitions, workflows, and subagents.

Project directories are in `~/Agents/Projects/`. When the user asks for a
project directory or names a project without a path, look there.

When the user says to start a project and provides a project directory path, run
`~/Agents/Projects/tools/start-project/start-project.sh` with that project
directory path as its argument.

Do not do any web searching.

Do not expand this home-level file with ongoing project or preference context.
For reusable guidance that is John-agnostic or host-VM-agnostic, update
`Agents/Documents/AGENTS.md` instead of this file. For guidance that is
specific to this home directory, John, or this host VM, update this home-level
file.
