import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  effectiveStatus, listPackages, loadSettings, parseCommand, projectStatus, replacePackage,
  saveSettings, selectPackage, sourceInfo, status, transition, TYPES,
} from '../src/config.mjs';

const source = 'git:github.com/example/tools@v1';
const entry = { source, skills: ['!skills/legacy/**'], extensions: ['+extensions/main.ts'] };
const row = (global, project) => listPackages({ packages: [global] }, project ? { packages: [project] } : {}, '/agent', '/project')[0];
const change = (r, scope, verb) => transition(r, { scope, verb });

test('requires exactly one explicit scope and supports quoted sources', () => {
  assert.equal(parseCommand(''), null);
  assert.deepEqual(parseCommand(' enable "/some path/package" --project '), { verb: 'enable', scope: 'project', target: '/some path/package' });
  assert.deepEqual(parseCommand('inherit tools'), { verb: 'inherit', scope: 'project', target: 'tools' });
  for (const args of ['enable tools', 'disable tools --global --project', 'enable tools --global --global', 'inherit tools --project', 'disable "tools --global', 'enable "x"y --global']) {
    assert.throws(() => parseCommand(args));
  }
});

test('global changes preserve manually selected resources and restore the original declaration', () => {
  const off = change(row(entry), 'global', 'disable');
  assert.equal(status(off), 'Disabled');
  for (const type of TYPES) assert.deepEqual(off[type], []);
  assert.deepEqual(change(row(off), 'global', 'enable'), entry);
  assert.equal(change(row(change(row(source), 'global', 'disable')), 'global', 'enable'), source);
});

test('project enable wins over global disable, preserving the original global filters', () => {
  const off = change(row(entry), 'global', 'disable');
  const on = change(row(off), 'project', 'enable');
  assert.equal(projectStatus(on), 'Explicitly enabled');
  assert.equal(effectiveStatus(off, on), 'Partially enabled');
  assert.deepEqual(on.extensions, entry.extensions);
  assert.deepEqual(on.skills, entry.skills);
  assert.equal(on.source, source); // Missing user installations retain Pi's remote fallback.
  assert.equal(change(row(off, on), 'project', 'inherit'), null);
  assert.equal(effectiveStatus(off, undefined), 'Disabled');
});

test('project enable reuses existing user git and npm installations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ext-shared-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [remote, segments] of [
    [source, ['git', 'github.com', 'example', 'tools']],
    ['npm:@org/foo@1', ['npm', 'node_modules', '@org', 'foo']],
  ]) {
    const userDir = join(root, remote.startsWith('git:') ? 'git-agent' : 'npm-agent');
    const projectDir = join(root, 'project');
    const installed = join(userDir, ...segments);
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, 'package.json'), '{}');
    const off = change(listPackages({ packages: [remote] }, {}, userDir, projectDir)[0], 'global', 'disable');
    const shared = listPackages({ packages: [off] }, {}, userDir, projectDir)[0];
    assert.equal(shared.sharedPath, installed);
    const on = change(shared, 'project', 'enable');
    assert.equal(on.source, installed);
    assert.equal(effectiveStatus(off, on), 'Enabled');
    const managed = listPackages({ packages: [off] }, { packages: [on] }, userDir, projectDir)[0];
    assert.equal(managed.project, on);
    assert.equal(managed.projectIndex, 0);
    assert.equal(change(managed, 'project', 'inherit'), null);
    const disabled = change(managed, 'project', 'disable');
    assert.equal(disabled.source, remote);
    assert.equal(disabled.autoload, false);
  }
});

test('project disable wins over global enable and removes only manager-owned changes', () => {
  const policy = { source, autoload: false, skills: ['-skills/extra/SKILL.md'] };
  const off = change(row(entry, policy), 'project', 'disable');
  assert.equal(projectStatus(off), 'Explicitly disabled');
  assert.equal(effectiveStatus(entry, off), 'Disabled');
  assert.deepEqual(change(row(entry, off), 'project', 'inherit'), policy);
  assert.throws(() => change(row(entry, policy), 'project', 'enable'), /native delta filters/);
  assert.deepEqual(change(row(entry, policy), 'project', 'inherit'), policy);
});

test('normalizes sources, rejects ambiguous short names, and guards external edits', () => {
  assert.equal(sourceInfo('git:git@github.com:example/tools.git@v2', '/a').id, sourceInfo(source, '/b').id);
  assert.equal(sourceInfo('npm:@org/foo@1', '/a').id, 'npm:@org/foo');
  assert.equal(sourceInfo('../pkgs/p', '/a/user').id, sourceInfo('../a/pkgs/p', '/b').id);
  const rows = listPackages({ packages: [source, 'git:github.com/other/tools'] }, {}, '/a', '/b');
  assert.throws(() => selectPackage(rows, 'tools'), /Ambiguous package/);
  assert.equal(selectPackage(rows, source).id, 'git:github.com/example/tools');
  const off = change(row(entry), 'global', 'disable');
  assert.throws(() => change(row({ ...off, skills: ['+something'] }), 'global', 'enable'), /edited externally/);
});

test('atomic settings writes retain unrelated keys and refuse stale snapshots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ext-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'settings.json');
  await writeFile(path, '{"theme":"dark","packages":["npm:demo"]}');
  const { raw, value } = await loadSettings(path);
  const next = replacePackage(value, 0, null);
  await saveSettings(path, raw, next);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { theme: 'dark' });
  await assert.rejects(() => saveSettings(path, raw, value), /Another process changed/);
});
