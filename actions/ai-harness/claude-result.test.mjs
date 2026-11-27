import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluate, parseResult } from './claude-result.mjs';

const json = (subtype, result, extra = {}) => JSON.stringify({ type: 'result', subtype, is_error: subtype !== 'success', result, ...extra });

describe('claude-result', () => {
  it('accepts a success result and returns its text', () => {
    assert.deepEqual(evaluate({ stdout: json('success', 'done'), stderr: '', status: 0 }), { output: 'done', errors: [] });
  });

  it('reads the result object after other printed lines', () => {
    assert.equal(parseResult(`warning: something\n${json('success', 'ok')}\n`).result, 'ok');
  });

  it('rejects a non-success subtype and an is_error result', () => {
    assert.match(evaluate({ stdout: json('error_max_turns', 'partial'), stderr: '', status: 0 }).errors[0], /error_max_turns/);
    assert.match(evaluate({ stdout: json('success', 'x', { is_error: true }), stderr: '', status: 0 }).errors[0], /is_error/);
  });

  it('rejects stopped background work on stdout or stderr', () => {
    const line = 'Background tasks still running 10m after the last turn (subagent "a", monitor "b"); stopping them. Set X=0 to wait indefinitely.';
    for (const where of ['stdout', 'stderr']) {
      const run = where === 'stdout'
        ? { stdout: `${line}\n${json('success', 'waiting')}`, stderr: '', status: 0 }
        : { stdout: json('success', 'waiting'), stderr: line, status: 0 };
      const { output, errors } = evaluate(run);
      assert.equal(output, 'waiting');
      assert.equal(errors.length, 1);
      assert.match(errors[0], /stopped unfinished background work/);
    }
  });

  it('does not mistake a result that quotes the message for stopped background work', () => {
    const quoted = 'The log said: Background tasks still running 10m after the last turn; stopping them.';
    assert.deepEqual(evaluate({ stdout: json('success', quoted), stderr: '', status: 0 }), { output: quoted, errors: [] });
  });

  it('keeps raw stdout as output when no JSON result was printed', () => {
    const { output, errors } = evaluate({ stdout: 'not json', stderr: '', status: 124 });
    assert.equal(output, 'not json');
    assert.deepEqual(errors, ['Claude Code exited with status 124.', 'Claude Code printed no JSON result.']);
  });
});
