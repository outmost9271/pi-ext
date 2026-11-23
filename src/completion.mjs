import { selectPackage } from './config.mjs';

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

export function completeArguments(input, rows = [], isAvailable = () => true) {
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
    try { if (!isAvailable(selectPackage(rows, target[1].replace(/^(['"])(.*)\1$/, '$2')))) return []; }
    catch { return []; }
    return [['--global', 'Change the default for all projects'], ['--project', 'Override the default in this project']]
      .filter(([flag]) => flag !== target[2] && flag.startsWith(target[2]))
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
    const name = [row.name, row.source, row.id].find((candidate) => {
      if (candidate.startsWith('--') || !quote(candidate)) return false;
      try { return selectPackage(rows, candidate).id === row.id; } catch { return false; }
    });
    const value = name && `${verb} ${quote(name)}${verb === 'inherit' ? '' : ' '}`;
    return value && value !== prefix ? [{ value, label: name, description: row.source }] : [];
  });
}
