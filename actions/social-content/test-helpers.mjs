// Fixtures shared by the social-content tests: review issue markers and a small manifest.
import { gzipSync } from 'node:zlib';

export const marker = (manifest) => `<!-- social-content-manifest:v1:${gzipSync(Buffer.from(JSON.stringify(manifest))).toString('base64')} -->`;
export const header = (platform, batch, revision = 1) => `<!-- social-content:batch platform=${platform} batch=${batch} revision=${revision} -->`;
export const manifestOf = (overrides = {}) => ({
  schema_version: 1,
  platform: 'instagram',
  batch_id: '2026-11-30-instagram',
  publication_date: '2026-11-30',
  items: [{ id: 'a', type: 'photo', date: '2026-11-30', publish_at: null }, { id: 'b', type: 'reel', date: '2026-12-02', publish_at: null }],
  approval: { status: 'pending', by: null, at: null, revision: null },
  review: { issue_number: 7, revision: 1 },
  state: {},
  ...overrides
});
export const bodyOf = (manifest, revision = manifest.review?.revision ?? 1) => `${header(manifest.platform, manifest.batch_id, revision)}\n## Batch\n\ntext\n\n${marker(manifest)}\n`;
