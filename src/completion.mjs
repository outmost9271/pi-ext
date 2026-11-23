import { effectiveStatus, selectPackage, status, transition } from './config.mjs';

const scopeItems = [
  ['--global', 'Change the default for all projects'],
  ['--project', 'Override the default in this project'],
];

export function availableScopes(row, verb, projectTrusted) {
  return (projectTrusted ? ['global', 'project'] : ['global']).filter((scope) => {
    const state = scope === 'global' ? status(row.global) : effectiveStatus(row.global, row.project);
    if (state === 'Disabled' && verb === 'disable') return false;
    if ((state === 'Enabled' || state === 'Partially enabled') && verb === 'enable') return false;
    try { return transition(row, { scope, verb }) !== (scope === 'global' ? row.global : row.project); }
    catch { return false; }
  });
}

const verbs = [
  ['enable', 'Enable a package globally or in this project'],
  ['disable', 'Disable a package globally or in this project'],
  ['inherit', 'Remove the project override and follow the global setting'],
  ['--help', 'Show command usage'],
];

function quote(target) {
  if (!/[\s"']/.test(target)) return target;
  if (!target.includes('"')) return `"${target}"`;
  if (!target.includes("'")) return `'${target}'`;
  return null;
}

export function completeArguments(input, rows = [], { isAvailable = () => true, projectTrusted = false } = {}) {
  const prefix = input.trimStart();
  const command = prefix.match(/^(enable|disable|inherit)\s+(.*)$/s);
  if (!command) {
    return verbs.filter(([verb]) => verb.startsWith(prefix) && !(verb === '--help' && prefix === verb)).map(([verb, description]) => ({
      value: verb === '--help' ? verb : `${verb} `, label: verb, description,
    }));
  }
  const [, verb, rest] = command;
  const target = rest.match(/^("[^"]*"|'[^']*'|[^\s"']+)\s+([^\s]*)$/);
  if (target) {
    if (verb === 'inherit') return [];
    let scopes;
    try {
      const row = selectPackage(rows, target[1].replace(/^(['"])(.*)\1$/, '$2'));
      if (!isAvailable(row)) return [];
      scopes = availableScopes(row, verb, projectTrusted);
    } catch { return []; }
    return scopeItems
      .filter(([flag]) => scopes.includes(flag.slice(2)) && flag !== target[2] && flag.startsWith(target[2]))
      .map(([flag, description]) => ({ value: `${verb} ${target[1]} ${flag}`, label: flag, description }));
  }
  if (!/^(?:"[^"]*"?|'[^']*'?|[^\s"']*)$/.test(rest)) return [];
  const unquoted = rest.replace(/^(['"])(.*)\1$/, '$2');
  if (verb === 'inherit' && unquoted && !/["']/.test(unquoted)) {
    try { if (isAvailable(selectPackage(rows, unquoted))) return []; } catch { /* Keep suggesting partial or ambiguous targets. */ }
  }
  const query = rest.replace(/^["']/, '').replace(/["']$/, '').toLowerCase();
  return rows.flatMap((row) => {
    if (!isAvailable(row) || row.ambiguousGlobal || ![row.name, row.source, row.id].some((part) => part.toLowerCase().includes(query))) return [];
    const scopes = verb === 'inherit' ? [] : availableScopes(row, verb, projectTrusted);
    if (verb !== 'inherit' && !scopes.length) return [];
    const name = [row.name, row.source, row.id].find((candidate) => {
      if (candidate.startsWith('--') || !quote(candidate)) return false;
      try { return selectPackage(rows, candidate).id === row.id; } catch { return false; }
    });
    const value = name && `${verb} ${quote(name)}${verb === 'inherit' ? '' : ' '}`;
    const description = scopes.length ? `${scopes.map((scope) => `--${scope}`).join(', ')} · ${row.source}` : row.source;
    return value && value !== prefix ? [{ value, label: name, description }] : [];
  });
}
