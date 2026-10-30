---
name: board
description: Read-only progress board of the project's specs by stage, derived from git. Use when the user says "show the board", "show progress", or "open the board".
disable-model-invocation: false
---

# Board

**Show the board.** Render every spec in `docs/specs/`, on the default branch or only on a work branch, as a card in five columns: **Candidate → Specced → Ready → Building → Shipped**. The columns and staging rules are the same in every delivery mode.

The board is read-only. Files and branches decide each stage: `Status:` lines and task checkboxes, spec branches, and merges; with GitHub links, a merged pull request from the spec's branch into the default branch also counts as that branch's merge. To move work, use the skill that does it (`to-spec`, `to-tasks`, `build`, `ship`); never edit cards or the generated page.

## Run it

From any directory inside the project, start the live board as a background process:

```bash
node <this skill's directory>/scripts/board.mjs --serve
```

It prints `Board at http://127.0.0.1:<port>/ (pid N)…` and keeps running. Give the user that URL, or open it for them. If this project's board already answers on that port, `--serve` prints `Board already running at <url>` and exits 0; give the user that URL. The page refreshes itself every few seconds from git and shows a banner when it cannot update. It listens on `127.0.0.1` only, on port 4178 or a free port when that is taken (for example by another project's board); `--port <n>` requires a specific port.

**Stop the board** when the user asks ("stop the board", "close the board"): run the script with `--stop` (add `--port <n>` if it was started with one). It stops this project's board on that port, or says there is none. Do not leave the board running past the session unless the user wants it.

Limit: a board that fell back to a free port can only be stopped by the session that started it (stop its background process) or with `--stop --port <n>`.

If the background start fails or exits immediately, use `--once`. It writes a self-contained HTML snapshot to `.git/flow/board.html` (the repository's common git directory, shared by worktrees) and prints the path; open that file or give the user the path, and run it again for fresh state. `--out <file>` writes elsewhere; `--repo <path>` targets another repository (any mode); `--json` prints the derived board instead, for answering in chat.

When the user wants progress in chat rather than a page, run `--json` and summarize the columns in a few lines.

## Read the cards

A card shows the spec number, title, task progress (`done/total`, from `- [x] NN: Title (#45)` checklist items or `### NN: Title (#45)` headings in the Tasks section), and the branch that set its stage.

**Stages.** An open spec branch is Building only when it changes something outside `docs/`; otherwise a ticked task moves the card, a draft stays in Specced, and an accepted spec with tasks sits in Ready. A spec with `Status: dropped`, or one that exists only on a branch whose pull request closed unmerged, leaves the columns; `--json` lists it under `dropped`.

**GitHub links** (when `gh` is installed and authenticated, and delivery is not `local`; an unset `Delivery` means GitHub when `origin` is on GitHub): cards also link the pull request (head branch matches the slug, or its body closes a task issue) and any task issues, with each state in text. When GitHub cannot be reached, the board renders from git alone and its header says why; pass that note on, never treat it as an error. `--no-github` skips `gh` entirely.

Markers flag what needs a human look:

- `no status line` or `unknown status "…"`: the card stays in Specced unless git shows more progress.
- `on branch <name>`: the spec is not on the default branch yet, so it never shows past Building.
- `number NNN also used by …`: two spec files share a number.

Report markers rather than fixing specs unasked.

Limits: a merged branch ships a spec only when it changed something outside `docs/` and the spec's tasks are done. With GitHub links, a merged pull request counts the same way when its merge commit is in the local clone; a rebase merge is judged by its last commit only. Without them, fast-forward merges, and squash merges later edited on the default branch, may show as Building; a spec reads as Shipped for good once its `Status:` line says `implemented`, which `build` or `ship` sets.

The script exits nonzero with a message when it is not inside a git repository or finds no default branch (`main`, `origin/HEAD`, `master`, or `init.defaultBranch`); report that message and the command you ran. Outside a repository, offer `git init` and stop on a no.
