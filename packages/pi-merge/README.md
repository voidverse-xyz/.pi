# pi-merge

`/merge` creates a synthesized continuation from two to six selected points in the
current session tree. It does not rewrite or delete source branches.

## Usage

```text
/merge
/merge <entry-id-or-prefix-or-single-token-label> [...]
```

With one argument, the current leaf is included automatically. The interactive tree
picker supports labels containing spaces. Use `Enter` to add the highlighted branch
and `q` to finish selecting (or cancel before two branches are selected). During
synthesis, `q` cancels the child process. `Esc` remains a fallback on the tree and
loader; `q` stays ordinary text in the generated-context editor. Later native Pi
selectors retain Pi's configured selection-cancel keys.

The current model synthesizes shared context, branch-specific work, agreements,
conflicts, unresolved questions, and the next practical step. The result is editable
before a new named session is created. You can draft a kickoff prompt, run it
immediately, or create only the merged session.

Optional source labels are unique and are rolled back if session creation is cancelled.
Child synthesis is tool-free, has bounded output and a five-minute timeout, and treats
branch transcripts as untrusted source material rather than instructions.
