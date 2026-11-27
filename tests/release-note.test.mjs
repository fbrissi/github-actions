// Runs the inline validation script of the reusable release-note.yml workflow against scratch git repositories. The
// script stays inline because callers of a reusable workflow do not check out this repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const workflow = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.github/workflows/release-note.yml'), 'utf8');

export function validationScript(text) {
  const lines = text.split('\n');
  const step = lines.findIndex((line) => line.includes('- name: Validate new release note'));
  const run = lines.findIndex((line, index) => index > step && /^ {8}run: \|$/.test(line));
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && !line.startsWith(' '.repeat(10))) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

// mapfile needs bash 4 or newer (macOS ships 3.2).
const modernBash = spawnSync('bash', ['-c', 'type mapfile']).status === 0;
const EXEMPT = '*.md docs/* .ai/* .github/*';
const root = mkdtempSync(join(tmpdir(), 'release-note-'));
const script = join(root, 'validate.sh');
writeFileSync(script, validationScript(workflow));
after(() => rmSync(root, { recursive: true, force: true }));

let count = 0;
function repository() {
  const dir = join(root, `repo-${++count}`);
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  write('CHANGELOG.md', '# Changelog\n\n## v1.0.0\n\n- first\n');
  write('src/app.js', 'x\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('tag', 'v1.0.0');
  const base = git('rev-parse', 'HEAD');
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'change');
  };
  const validate = (exemptPaths = EXEMPT) => {
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const result = spawnSync('bash', [script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: git('rev-parse', 'HEAD'),
        CHANGELOG: 'CHANGELOG.md',
        CHECK_PACKAGE_VERSION: 'false',
        PACKAGE_JSON: 'package.json',
        ALLOW_EMPTY_BASE_HEADING: 'false',
        EXEMPT_PATHS: exemptPaths,
        GITHUB_OUTPUT: output
      }
    });
    return { status: result.status, stdout: result.stdout, output: readFileSync(output, 'utf8') };
  };
  const addHeading = () => write('CHANGELOG.md', '# Changelog\n\n## v1.0.1\n\n- second\n\n## v1.0.0\n\n- first\n');
  return { git, write, commit, validate, addHeading };
}

describe('release-note exempt-paths', { skip: !modernBash && 'needs bash 4 or newer' }, () => {
  it('passes a docs, agent configuration, and CI only change without a heading', () => {
    const repo = repository();
    repo.write('README.md', 'readme\n');
    repo.write('docs/guide/setup.txt', 'docs\n');
    repo.write('.ai/notes.txt', 'agent\n');
    repo.write('.github/workflows/ci.yml', 'name: CI\n');
    repo.commit();
    const result = repo.validate();
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /no release note is needed/);
    assert.equal(result.output, 'version=\n');
    assert.notEqual(repo.validate('').status, 0);
  });

  it('requires a heading when application code changes too', () => {
    const repo = repository();
    repo.write('docs/guide.md', 'docs\n');
    repo.write('src/app.js', 'y\n');
    repo.commit();
    assert.notEqual(repo.validate().status, 0);
    repo.addHeading();
    repo.commit();
    const result = repo.validate();
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.output, 'version=v1.0.1\n');
  });

  it('does not exempt a file renamed out of src/ into docs/', () => {
    const repo = repository();
    repo.write('docs/.keep', '');
    repo.git('mv', 'src/app.js', 'docs/app.js');
    repo.commit();
    assert.notEqual(repo.validate().status, 0);
  });

  it('still validates a heading added to an exempt change', () => {
    const repo = repository();
    repo.write('docs/guide.md', 'docs\n');
    repo.write('CHANGELOG.md', '# Changelog\n\n## v1.0.0\n\n- first\n\n## v1.0.1\n\n- misplaced\n');
    repo.commit();
    assert.notEqual(repo.validate().status, 0);
  });
});
