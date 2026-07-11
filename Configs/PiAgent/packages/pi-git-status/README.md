# pi-git-status

A single status row above Pi's editor:

- left: home-relative current directory, then rich Git state when in a repository
- right: current model and thinking level

It shows the repository and branch, plus indicators when relevant for:

- linked worktrees
- rebase, merge, cherry-pick, revert, or bisect operations
- conflicts and uncommitted changes
- ahead/behind counts from the local tracking ref
- stashes

It never fetches from the network; ahead/behind reflects the most recently fetched
tracking ref. Git state refreshes after each agent turn and every 15 seconds. Outside
a repository the row still shows the directory, model, and thinking level. Nerd Font
glyphs are used for several Git indicators.
