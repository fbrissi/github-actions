#!/usr/bin/env node
// Turns a `claude --print --output-format json` run into the harness output file and an exit status.
// The CLI can exit 0 after a run that did not finish: print mode stops background work still running at its wait
// ceiling and drops it. A run counts as finished only with a `success` result and no stopped background work.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const STOPPED_BACKGROUND = /Background tasks still running[^\n]*stopping them/;

export function parseResult(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Anything printed before the result object: take the last line that parses as one.
    for (const line of text.split('\n').reverse()) {
      if (!line.trim().startsWith('{')) continue;
      try {
        return JSON.parse(line);
      } catch {
        // keep looking
      }
    }
    return null;
  }
}

export function evaluate({ stdout, stderr, status }) {
  const result = parseResult(stdout);
  const output = typeof result?.result === 'string' ? result.result : stdout;
  const errors = [];
  if (status !== 0) errors.push(`Claude Code exited with status ${status}.`);
  if (!result) errors.push('Claude Code printed no JSON result.');
  else if (result.is_error || result.subtype !== 'success') {
    errors.push(`Claude Code ended with ${result.subtype ?? 'an unknown result'}${result.is_error ? ' (is_error)' : ''}.`);
  }
  // Search the CLI's own lines only: the result text may quote the message (a review of this very check).
  const cliLines = stdout.split('\n').filter((line) => !line.trim().startsWith('{')).join('\n');
  const stopped = `${cliLines}\n${stderr}`.match(STOPPED_BACKGROUND);
  if (stopped) {
    errors.push(`Claude Code stopped unfinished background work, so the run did not finish: ${stopped[0]}`);
  }
  return { output, errors };
}

export function main([stdoutFile, stderrFile, outputFile, status], write = console.log) {
  const read = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  const { output, errors } = evaluate({ stdout: read(stdoutFile), stderr: read(stderrFile), status: Number(status) });
  writeFileSync(outputFile, output.endsWith('\n') || !output ? output : `${output}\n`);
  write(output);
  for (const error of errors) write(`::error::${error}`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
