# pi-git-status

A compact Git-only status row above Pi's editor.

It shows the repository and branch, plus indicators when relevant for:

- linked worktrees
- rebase, merge, cherry-pick, revert, or bisect operations
- conflicts and uncommitted changes
- ahead/behind counts from the local tracking ref
- stashes

It does not display the current directory, model, or thinking level. It never fetches
from the network; ahead/behind reflects the most recently fetched tracking ref.

The status refreshes after each agent turn and every 15 seconds. Outside a Git
repository it renders no row. Nerd Font glyphs are used for several indicators.
