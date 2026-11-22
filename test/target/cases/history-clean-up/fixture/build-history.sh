#!/usr/bin/env bash
# Builds the branch the agent starts on: seven noisy commits on top of the first one.
set -euo pipefail
git checkout -q -b feature/checkout
step() {
  printf '%s\n' "$2" >> src/cart.js
  git add -A
  git commit -q -m "$1"
}
step "wip" "export const tax = (amount) => amount * 0.2;"
step "oops" "export const shipping = () => 5;"
step "wip 2" "export const discount = (amount) => amount * 0.9;"
step "fixup! wip" "export const round = (amount) => Math.round(amount * 100) / 100;"
step "tmp" "export const grand = (items) => round(total(items) + shipping());"
step "more fixes" 'export const label = (amount) => "$" + amount;'
step "again" "export const free = (items) => total(items) > 100;"
