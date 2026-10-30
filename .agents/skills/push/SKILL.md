---
name: push
description: Push the current or named branch with no pull request, review, or CI wait, then a light liveness check of the pushed commit; the host's Git integration deploys it. Use when the user says "push it" or "deploy it".
disable-model-invocation: false
---

# Push

## Outcome

**"Push it"** (or "deploy it") is the approval: no confirmation after it. The current branch, or the branch the user names, holds this work's commit on the remote, and its liveness is reported. Pushing is the deploy: the host's Git integration (for example Vercel) builds the pushed branch. Push runs no deploy command of its own.

**Proof.** The remote branch contains the pushed commit; liveness is reported as `ship`'s Liveness describes.

## Push

Outside a Git repository, offer `git init` and stop on a no. With no remote, commit and say nothing was published.

- Commit this work's uncommitted changes first, with a Conventional Commits message: no credentials, local logs, or generated secrets. Leave unrelated changes uncommitted and report them.
- Push the current branch, or the named one; the default branch only when it is current or named. No pull request, review, or CI wait; for those, the user says "build it" or "ship it".
- When the push is rejected because the remote moved, fetch, merge the remote branch, and push once; on a conflict, stop and report the local-only commits.

Never force-push or rewrite remote branches. Never push other people's work. Never bypass protection; when it refuses the push, stop and say so.

## Output

Report the branch, the pushed commit, liveness, and anything left uncommitted.
