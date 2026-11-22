#!/usr/bin/env node
import { installFatalHandlers } from "./fatal.js";
import { main } from "./cli.js";

// The command line starts after the paths of node and of this script.
const FIRST_ARGUMENT = 2;

installFatalHandlers();
process.exitCode = await main(process.argv.slice(FIRST_ARGUMENT));
