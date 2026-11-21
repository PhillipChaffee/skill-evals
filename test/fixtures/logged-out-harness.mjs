#!/usr/bin/env node
// Stands in for a harness that is installed but has no login: one line on stderr, no stream, exit 1.
import process from "node:process";

process.stderr.write(
  "Error: Authentication required. Please run 'agent login' first.\n",
);
process.exit(1);
