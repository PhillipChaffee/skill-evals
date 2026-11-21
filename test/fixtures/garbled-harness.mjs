#!/usr/bin/env node
// Stands in for a harness whose stream has an event the Codex adapter does not expect: a finished turn with no usage.
console.log(JSON.stringify({ type: "turn.completed" }));
