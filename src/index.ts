#!/usr/bin/env node
/*
  The `luxalgo-mcp` binary (`npx -y @luxalgo/mcp`): the local stdio server
  and its `login` / `logout` / `status` subcommands. Everything lives in
  entries/stdio.ts; this file only exists so the bin path stays stable.
*/
import { main } from "./entries/stdio.js";

main();
