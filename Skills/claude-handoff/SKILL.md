---
name: claude-handoff
description: Use when the user says to use Claude, hand work to Claude, ask Claude, have Claude handle a task, or specifies a Claude model for the work. Treat this as an instruction that the Claude CLI is installed locally and should be used to hand off the requested work, passing the specified model when provided.
---

# Claude Handoff

Treat a user request to "use Claude" as a request to invoke the installed `claude` CLI and hand off the current work to it.

Build a concise handoff prompt that includes the user's goal, relevant local paths, important constraints, and the expected output. If the user specifies a Claude model, preserve the exact model name and pass it through the CLI's model option, such as `claude --model <model>`. If the local CLI syntax is uncertain, check `claude --help` and use the supported equivalent.

After Claude runs, inspect its output and any file changes before continuing or reporting back to the user.
