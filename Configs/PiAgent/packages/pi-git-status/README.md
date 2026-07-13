# pi-git-status

Publishes a home-relative current directory and rich Git state through the
reserved `git-status` extension-status key. `pi-status-line` consumes that value
and positions it on the left side of the shared row above Pi's editor.

It shows the repository and branch, plus indicators when relevant for:

- linked worktrees
- rebase, merge, cherry-pick, revert, or bisect operations
- conflicts and uncommitted changes
- ahead/behind counts from the local tracking ref
- stashes

It never fetches from the network; ahead/behind reflects the most recently fetched
tracking ref. Git state refreshes after each agent turn and every 15 seconds. Outside
a repository the status still shows the directory. Nerd Font glyphs are used for
several Git indicators.
