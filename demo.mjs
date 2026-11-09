import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { init, sha, write } from './controller.mjs';

const repo = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(repo, '.demo');
const working = 'CODEX_Licencjat/04_ROBOCZE_CODEX';
const artifact = `${working}/article.md`;
const map = `${working}/map.json`;
const sources = 'sources';
const output = `${working}/run`;
const wording = 'In the fictional trial, 8 of 10 seedlings germinated.';
const registry = path.join(root, output, 'registry.json');

if (fs.existsSync(registry)) {
  console.log(`Demo already initialized: ${path.relative(repo, registry)}`);
  process.exit(0);
}

fs.mkdirSync(path.join(root, sources), { recursive: true });
fs.mkdirSync(path.join(root, working), { recursive: true });
fs.cpSync(path.join(repo, '.opencode'), path.join(root, '.opencode'), { recursive: true });
fs.writeFileSync(path.join(root, artifact), `${wording}\n`);
fs.writeFileSync(path.join(root, sources, 'trial.md'),
  `---\nsource_sha256: ${'a'.repeat(64)}\n---\n<!-- PDF_PAGE: 1 -->\n${wording}\n`);
write(path.join(root, map), {
  artifact_sha256: sha(path.join(root, artifact)),
  claims: [{
    claim_id: 'DEMO-B01-C001', wording, location: 'paragraph 1',
    information_type: 'OBSERVATION', risk: 'MEDIUM', requires_source: true,
    artifact_excerpt_exact: wording,
  }],
});

const config = path.join(root, 'config.json');
write(config, {
  project_root: root, audit_id: 'SYNTHETIC-DEMO', artifact_path: artifact,
  map_path: map, source_dir: sources, output_dir: output, roles: ['B', 'C'],
  opencode_cli: process.env.OPENCODE_CLI || 'opencode',
  opencode_model: process.env.OPENCODE_MODEL || '',
});

init(config);
console.log(`Demo registry: ${path.relative(repo, registry)}`);
