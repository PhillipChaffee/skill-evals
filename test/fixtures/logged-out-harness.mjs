#!/usr/bin/env node
// Stands in for a harness that is installed but has no login: one line on stderr, no stream, exit 1.
console.error("Error: Authentication required. Please run 'agent login' first.");
process.exit(1);
