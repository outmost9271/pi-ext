import assert from 'node:assert/strict';
import test from 'node:test';
import { completeArguments } from '../src/completion.mjs';
import { listPackages, parseCommand, transition } from '../src/config.mjs';

const packages = (...sources) => listPackages({ packages: sources }, {}, '/user', '/project');
const values = (prefix, rows, options = { projectTrusted: true }) => completeArguments(prefix, rows, options).map((item) => item.value);
const rows = packages('npm:fixture@1', 'git:github.com/example/tools@v1', '/local/my package');
const disabled = (row, scope) => transition(row, { verb: 'disable', scope });

test('completes actions, package names, and scopes as full argument strings', () => {
  assert.deepEqual(values(''), ['enable ', 'disable ', 'inherit ', '--help']);
  assert.deepEqual(values('dis'), ['disable ']);
  assert.deepEqual(values('disable fix', rows), ['disable fixture ']);
  assert.deepEqual(values('disable fixture ', rows), ['disable fixture --global', 'disable fixture --project']);
  assert.deepEqual(values('disable fixture --g', rows), ['disable fixture --global']);
  assert.deepEqual(values('disable fixture --global ', rows), []);
  assert.deepEqual(values('disable unknown ', rows), []);
  assert.deepEqual(values('inherit fix', rows), ['inherit fixture']);
  assert.deepEqual(values('inherit fixture ', rows), []);
});

test('accepts extra separators, trailing spaces on partial tokens, and both quote forms', () => {
  for (const prefix of [' en', '  en ', '\t en  ']) assert.deepEqual(values(prefix, rows), ['enable ']);
  for (const prefix of ['disable fix ', '  disable  fix  ', 'disable  "fix"  ']) {
    assert.deepEqual(values(prefix, rows), ['disable fixture ']);
  }
  assert.deepEqual(values(" disable  'fixture'   --pr  ", rows), ["disable 'fixture' --project"]);
  assert.deepEqual(values(' disable   "fixture"   -- ', rows), ['disable "fixture" --global', 'disable "fixture" --project']);
  for (const prefix of ['--help', 'disable fixture --global', 'disable fixture --bogus', 'disable fixture --global --project', 'inherit fixture --project']) {
    assert.deepEqual(values(prefix, rows), []);
  }
});

test('handles quoted and ambiguous package names and skips unavailable packages', () => {
  assert.deepEqual(values('inherit "my p', rows), ['inherit "my package"']);
  assert.deepEqual(values('inherit "my p', rows).map(parseCommand), [
    { verb: 'inherit', target: 'my package', scope: 'project' },
  ]);
  const ambiguous = packages('git:github.com/example/tools', 'git:github.com/other/tools');
  assert.deepEqual(values('inherit tools', ambiguous, { isAvailable: (row) => row.source.includes('/other/') }), ['inherit git:github.com/other/tools']);
  assert.deepEqual(values('enable tools ', ambiguous), []);
});

test('shows only packages and scopes where the requested state would change', () => {
  const [on, other] = rows;
  const off = { ...other, global: disabled(other, 'global') };
  assert.deepEqual(values('enable ', [on, off]), ['enable tools ']);
  assert.deepEqual(values('disable ', [on, off]), ['disable fixture ']);

  const mixed = { ...on, project: disabled(on, 'project') };
  assert.deepEqual(values('enable fixture ', [mixed]), ['enable fixture --project']);
  assert.deepEqual(values('disable fixture ', [mixed]), ['disable fixture --global']);
  assert.deepEqual(values('enable ', [mixed], { projectTrusted: false }), []);
  const reverse = { ...off, project: transition(off, { verb: 'enable', scope: 'project' }) };
  assert.deepEqual(values('enable tools ', [reverse]), ['enable tools --global']);
  assert.deepEqual(values('disable tools ', [reverse]), ['disable tools --project']);
});
