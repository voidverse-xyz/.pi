# pi-questions

Registers the LLM-callable `ask_user` tool for structured interactive questions.

Supported inputs:

- free text with optional regular-expression validation
- single choice
- multiple choice
- file or directory selection

Inputs support stable IDs, defaults, optional answers, descriptions, and custom
“Something else” choices. One call may contain up to ten inputs and fifty options per
choice input; individual text answers are limited to 16 KiB.

The tool intentionally requires Pi's interactive TUI. Legacy IPC forwarding was
removed because it targeted the archived subprocess subagent system. A headless agent
receives a proper tool error and must continue with stated assumptions.
