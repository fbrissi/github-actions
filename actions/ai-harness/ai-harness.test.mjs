import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let root;
let home;
let checkout;
let bin;

const write = (path, content, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
};

const agentFile = (mode) => `---\ndescription: Test agent\n${mode ? `mode: ${mode}\n` : ''}---\nBody\n`;

const run = (script, env) => spawnSync('bash', [join(here, script)], {
  cwd: checkout,
  encoding: 'utf8',
  env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, RUNNER_TEMP: root, GITHUB_WORKSPACE: checkout, ...env }
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ai-harness-'));
  home = join(root, 'home');
  checkout = join(root, 'checkout');
  bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(checkout, { recursive: true });
  // Stubs: timeout drops its three options and runs the command; the harnesses print their arguments.
  write(join(bin, 'timeout'), '#!/usr/bin/env bash\nshift 3\nexec "$@"\n', 0o755);
  write(join(bin, 'opencode'), '#!/usr/bin/env bash\nprintf "opencode %s\\n" "$*"\n', 0o755);
  write(join(bin, 'claude'), '#!/usr/bin/env bash\ncat >/dev/null\nprintf "claude %s\\n" "$*"\n', 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('install-assets.sh', () => {
  it('installs OpenCode agents from opencode-agents-local-dir into ~/.config/opencode/agents', () => {
    const source = join(root, 'opencode-agents');
    write(join(source, 'task-implementer.md'), agentFile('primary'));
    const result = run('install-assets.sh', {
      AI_HARNESS: 'opencode',
      AGENTS: 'task-implementer',
      OPENCODE_AGENTS_LOCAL_DIR: source,
      AGENTS_LOCAL_DIR: join(root, 'claude-agents')
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(home, '.config/opencode/agents/task-implementer.md')));
    assert.ok(!existsSync(join(home, '.claude/agents')));
  });

  it('installs Claude Code agents from agents-local-dir into ~/.claude/agents', () => {
    const source = join(root, 'claude-agents');
    write(join(source, 'developer.md'), agentFile());
    const result = run('install-assets.sh', { AI_HARNESS: 'claude', AGENTS: 'developer', AGENTS_LOCAL_DIR: source });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(home, '.claude/agents/developer.md')));
  });

  it('fails when the checkout defines an OpenCode agent with the same name', () => {
    const source = join(root, 'opencode-agents');
    write(join(source, 'developer.md'), agentFile('subagent'));
    write(join(checkout, '.opencode/agent/developer.md'), agentFile('subagent'));
    const result = run('install-assets.sh', { AI_HARNESS: 'opencode', AGENTS: 'developer', OPENCODE_AGENTS_LOCAL_DIR: source });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /\.opencode\/agent\/developer\.md, which would override/);
  });

  it('rejects an absolute opencode-agents-path', () => {
    const result = run('install-assets.sh', { AI_HARNESS: 'opencode', AGENTS: 'developer', OPENCODE_AGENTS_PATH: '/etc' });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /opencode-agents-path must be a relative path/);
  });
});

describe('run.sh', () => {
  const output = () => join(root, 'out.txt');
  const base = (harness, extra = {}) => ({ AI_HARNESS: harness, AI_PROMPT: 'do it', AI_OUTPUT_FILE: output(), ...extra });

  it('runs OpenCode with --agent when the agent is installed and primary', () => {
    write(join(home, '.config/opencode/agents/task-implementer.md'), agentFile('primary'));
    const result = run('run.sh', base('opencode', { AI_AGENT: 'task-implementer', OPENCODE_MODEL: 'openai/gpt-5' }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(output(), 'utf8'), /^opencode run --thinking --dangerously-skip-permissions --model=openai\/gpt-5 --agent=task-implementer do it$/m);
  });

  it('runs OpenCode without --agent when no agent is set', () => {
    const result = run('run.sh', base('opencode'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(readFileSync(output(), 'utf8'), /--agent/);
  });

  it('fails when the OpenCode agent is not installed', () => {
    const result = run('run.sh', base('opencode', { AI_AGENT: 'task-implementer' }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not installed in ~\/\.config\/opencode\/agents/);
  });

  it('fails when the OpenCode agent is a subagent', () => {
    write(join(home, '.config/opencode/agents/developer.md'), agentFile('subagent'));
    const result = run('run.sh', base('opencode', { AI_AGENT: 'developer' }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /mode 'subagent'/);
  });

  it('fails when the checkout overrides the OpenCode agent', () => {
    write(join(home, '.config/opencode/agents/task-implementer.md'), agentFile('primary'));
    write(join(checkout, '.opencode/agents/task-implementer.md'), agentFile('primary'));
    const result = run('run.sh', base('opencode', { AI_AGENT: 'task-implementer' }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /which would override the installed agent 'task-implementer'/);
  });

  it('runs Claude Code with --agent', () => {
    write(join(home, '.claude/agents/task-implementer.md'), agentFile());
    const result = run('run.sh', base('claude', { AI_AGENT: 'task-implementer', ANTHROPIC_API_KEY: 'test' }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(output(), 'utf8'), /--agent task-implementer/);
  });

  it('appends per-run instructions to the prompt, also with an OpenCode command', () => {
    const result = run('run.sh', base('opencode', { OPENCODE_COMMAND: 'pr/review', AI_PROMPT: '12', AI_INSTRUCTIONS: 'Focus on security.' }));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(readFileSync(output(), 'utf8'), /--command=pr\/review 12\n\nAdditional instructions for this run:\nFocus on security\.$/m);
  });

  it('rejects an invalid agent name', () => {
    const result = run('run.sh', base('opencode', { AI_AGENT: '../evil' }));
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Invalid agent name/);
  });
});
