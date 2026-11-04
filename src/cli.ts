#!/usr/bin/env node
import { runDoctor } from "./doctor.js";
import { VERSION } from "./version.js";

const HELP = `usage: slashpeak [--version] <command>

SlashPeak Job Router tools.

commands:
  doctor             check the key, the network path and reservation access
  doctor --latency   also measure 20 warm round trips`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--version")) {
    console.log(`slashpeak ${VERSION}`);
    return 0;
  }
  if (argv[0] === "doctor") return runDoctor({ latency: argv.includes("--latency") });
  console.log(HELP);
  return argv.includes("--help") || argv.includes("-h") ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  }
);
