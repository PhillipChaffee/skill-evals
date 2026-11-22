#!/usr/bin/env bash
# Reads the branch the agent left. $SKILL_EVALS_SEED_DIR holds the repository as the agent found it.
set -u
noise='^(wip|oops|fixup|squash|tmp|temp|more|again)'
case "$1" in
  tree)
    before=$(git -C "$SKILL_EVALS_SEED_DIR" rev-parse 'HEAD^{tree}')
    after=$(git rev-parse 'HEAD^{tree}')
    [ "$before" = "$after" ] && echo "ok same tree" || { echo "tree changed: $before -> $after"; exit 1; }
    ;;
  count)
    count=$(git rev-list --count main..HEAD)
    [ "$count" -ge 1 ] && [ "$count" -le 4 ] && echo "ok $count commits" || { echo "$count commits"; exit 1; }
    ;;
  subjects)
    noisy=$(git log --format=%s main..HEAD | grep -Eic "$noise" || true)
    [ "$noisy" -eq 0 ] && echo "ok no noise" || { echo "$noisy noisy subjects"; exit 1; }
    ;;
esac
