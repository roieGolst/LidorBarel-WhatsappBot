#!/usr/bin/env bash
# The ONLY thing the GitHub Actions deploy key can run on this server.
#
# It is installed as a forced command in ~/.ssh/authorized_keys (see
# docs/GO-LIVE.md §9), so whatever the client asks for, sshd runs this instead
# and hands over the request as SSH_ORIGINAL_COMMAND. The workflow sends the
# commit sha it just tested. A leaked key therefore cannot open a shell, read
# .env, or touch the database: it can deploy a commit that is already on main.
set -euo pipefail

# Everything lives in a function so bash has parsed the whole file before any of
# it runs — the fast-forward below may rewrite this very script mid-execution.
main() {
  local sha="${SSH_ORIGINAL_COMMAND:-}"
  if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
    echo "remote-deploy: expected a full commit sha, got something else" >&2
    exit 2
  fi

  cd "$(dirname "$0")/.."

  # One deploy at a time — a CD run must not race a manual ./deploy/deploy.sh
  # started by hand, or another CD run.
  exec 9>.deploy.lock
  if ! flock -n 9; then
    echo "remote-deploy: another deploy is running" >&2
    exit 5
  fi

  # A detached HEAD means someone rolled back on purpose (GO-LIVE §8). The next
  # merge must not silently undo that; `git checkout main` resumes CD.
  if [[ "$(git symbolic-ref -q --short HEAD || true)" != "main" ]]; then
    echo "remote-deploy: the server is not on main (pinned to a rollback?) — refusing" >&2
    exit 4
  fi

  git fetch --quiet origin main
  # stderr silenced: a sha git has never seen is a refusal, not a git error.
  if ! git merge-base --is-ancestor "$sha" origin/main 2>/dev/null; then
    echo "remote-deploy: $sha is not on origin/main — refusing" >&2
    exit 3
  fi

  if git merge-base --is-ancestor "$sha" HEAD; then
    # An older run arriving late, or a re-run: never move the server backwards.
    echo "remote-deploy: already at or past $sha — redeploying the current checkout"
  else
    git merge --ff-only "$sha"
  fi

  # A fresh process, so it is the just-pulled deploy.sh that runs.
  exec ./deploy/deploy.sh
}

main "$@"
