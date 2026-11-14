// Shared command-line plumbing for scripts/: --help, argument errors (exit 2), uncaught errors (exit 1).
// Uses process.exitCode rather than process.exit so large stdout (an OpenVEX document) is never cut off.

import { parseArgs } from 'node:util';

export function parseCli(help, options = {}, { allowPositionals = false } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals, strict: true });
  } catch (err) {
    console.error(`${err.message}\nRun with --help for usage.`);
    process.exit(2);
  }
  if (parsed.values.help) {
    console.log(help.trim());
    process.exit(0);
  }
  return parsed;
}

/** Usage error: print and exit 2. */
export function usage(message) {
  console.error(`${message}\nRun with --help for usage.`);
  process.exit(2);
}

/** The useful line of an error: the contract's panic text when there is one, otherwise the first line. */
export function errorText(err) {
  const msg = String(err?.message ?? err);
  const m = msg.match(/Smart contract panicked: ([^\n"]+)/);
  return m ? m[1] : msg.split('\n')[0];
}

export function runMain(fn) {
  fn().then(
    (code) => {
      process.exitCode = code ?? 0;
    },
    (err) => {
      console.error(`error: ${errorText(err)}`);
      process.exitCode = 1;
    },
  );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
