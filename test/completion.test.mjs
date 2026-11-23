import assert from 'node:assert/strict';
import test from 'node:test';
import { completeArguments } from '../src/completion.mjs';
import { listPackages, parseCommand } from '../src/config.mjs';

const packages = (...sources) => listPackages({ packages: sources }, {}, '/user', '/project');
const values = (prefix, rows, available) => completeArguments(prefix, rows, available).map((item) => item.value);
const rows = packages('npm:fixture@1', 'git:github.com/example/tools@v1', '/local/my package');

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

test('handles quoted and ambiguous package names and skips unavailable packages', () => {
  assert.deepEqual(values('enable "my p', rows), ['enable "my package" ']);
  assert.deepEqual(values('enable "my package" --p', rows).map(parseCommand), [
    { verb: 'enable', target: 'my package', scope: 'project' },
  ]);
  const ambiguous = packages('git:github.com/example/tools', 'git:github.com/other/tools');
  assert.deepEqual(values('inherit tools', ambiguous, (row) => row.source.includes('/other/')), ['inherit git:github.com/other/tools']);
  assert.deepEqual(values('enable tools ', ambiguous), []);
});
