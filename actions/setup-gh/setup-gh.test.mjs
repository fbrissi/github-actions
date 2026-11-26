import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = '9.9.9';
const TOOLS = ['bash', 'cat', 'cut', 'cp', 'gzip', 'head', 'mkdir', 'perl', 'rm', 'sed', 'sha256sum', 'shasum', 'sort', 'tar', 'tr'];

let root;
let bin;
let fixture;

const write = (path, content, mode) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
};

function which(tool) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, tool))) return join(dir, tool);
  }
  return null;
}

// A tarball laid out like the official release, with a gh that prints its version.
function buildFixture(arch) {
  const name = `gh_${VERSION}_linux_${arch}`;
  const src = join(root, 'src');
  write(join(src, name, 'bin', 'gh'), `#!/usr/bin/env bash\necho "gh version ${VERSION} (test)"\n`, 0o755);
  const archive = join(root, `${name}.tar.gz`);
  const result = spawnSync('tar', ['-czf', archive, '-C', src, name]);
  assert.equal(result.status, 0, String(result.stderr));
  return { archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex') };
}

const run = (env = {}) => spawnSync('bash', [join(here, 'setup-gh.sh')], {
  encoding: 'utf8',
  env: { PATH: bin, RUNNER_TEMP: join(root, 'tmp'), GITHUB_PATH: join(root, 'github-path'), GH_SETUP_VERSION: VERSION, ...env }
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'setup-gh-'));
  bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, 'tmp'), { recursive: true });
  // Only the tools the script needs, so a gh installed on the machine running the tests stays out of the PATH.
  for (const tool of TOOLS) {
    const path = which(tool);
    if (path) symlinkSync(path, join(bin, tool));
  }
  write(join(bin, 'uname'), '#!/usr/bin/env bash\nif [ "$1" = -s ]; then echo Linux; else echo "${FAKE_ARCH:-x86_64}"; fi\n', 0o755);
  // curl copies the fixture to the --output path.
  write(join(bin, 'curl'), '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = --output ]; then cp "$FIXTURE" "$2"; fi; shift; done\n', 0o755);
  fixture = buildFixture('amd64');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('setup-gh', () => {
  it('keeps an installed gh', () => {
    write(join(bin, 'gh'), '#!/usr/bin/env bash\necho "gh version 2.50.0 (x)"\n', 0o755);
    const result = run({ FIXTURE: fixture.archive });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2\.50\.0 is already installed/);
    assert.equal(existsSync(join(root, 'github-path')), false);
  });

  it('installs the pinned release when gh is missing and adds it to the PATH', () => {
    const result = run({ FIXTURE: fixture.archive, GH_SETUP_SHA256_AMD64: fixture.sha256 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const added = readFileSync(join(root, 'github-path'), 'utf8').trim();
    assert.equal(added, join(root, 'tmp', `gh-${VERSION}`, `gh_${VERSION}_linux_amd64`, 'bin'));
    assert.ok(existsSync(join(added, 'gh')));
  });

  it('picks the arm64 build on arm64 runners', () => {
    const arm = buildFixture('arm64');
    const result = run({ FIXTURE: arm.archive, FAKE_ARCH: 'aarch64', GH_SETUP_SHA256_ARM64: arm.sha256 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(readFileSync(join(root, 'github-path'), 'utf8'), /linux_arm64\/bin/);
  });

  it('replaces a gh older than min-version', () => {
    write(join(bin, 'gh'), '#!/usr/bin/env bash\necho "gh version 2.40.1 (x)"\n', 0o755);
    const result = run({ FIXTURE: fixture.archive, GH_SETUP_SHA256_AMD64: fixture.sha256, GH_SETUP_MIN_VERSION: '2.48.0' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /older than 2\.48\.0/);
    assert.ok(existsSync(join(root, 'github-path')));
  });

  it('refuses a download whose checksum does not match', () => {
    const result = run({ FIXTURE: fixture.archive, GH_SETUP_SHA256_AMD64: '0'.repeat(64) });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /Checksum mismatch/);
    assert.equal(existsSync(join(root, 'github-path')), false);
  });

  it('fails on an unsupported architecture', () => {
    const result = run({ FIXTURE: fixture.archive, FAKE_ARCH: 'riscv64' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /No pinned GitHub CLI build/);
  });
});
