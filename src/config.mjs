import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const TYPES = ['extensions', 'skills', 'prompts', 'themes'];
const META = 'x-pi-ext';
export const usage = 'Usage: /extensions <enable|disable> <package> <--global|--project> or /extensions inherit <package>. Choose exactly one scope for enable or disable.';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sourceOf = (entry) => typeof entry === 'string' ? entry : entry.source;
const filters = (value) => Object.fromEntries(TYPES.map((type) => [type, [...value]]));

export function parseCommand(args) {
  const words = args.trim().match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  if (!args.trim()) return null;
  if (!/^(?:\s*(?:"[^"]*"|'[^']*'|[^\s"']+)(?=\s|$))+\s*$/.test(args)) throw new Error(usage);
  const [verb, target, scope] = words;
  const name = target?.replace(/^(['"])(.*)\1$/, '$2');
  if (!name || name.startsWith('--')) throw new Error(usage);
  if (verb === 'inherit' && words.length === 2) return { verb, target: name, scope: 'project' };
  if ((verb === 'enable' || verb === 'disable') && words.length === 3 && ['--global', '--project'].includes(scope)) {
    return { verb, target: name, scope: scope.slice(2) };
  }
  throw new Error(usage);
}

export function sourceInfo(source, base) {
  const value = source.trim();
  if (source.startsWith('npm:')) {
    const name = source.slice(4).trim().match(/^(@?[^@]+)(?:@.*)?$/)?.[1] ?? source.slice(4).trim();
    return { id: `npm:${name}`, name, source };
  }
  if (value.startsWith('git:') || /^(https?|ssh|git):\/\//i.test(value)) {
    const raw = (value.startsWith('git:') ? value.slice(4).trim() : value).split('#')[0];
    const shorthand = raw.match(/^(github|gitlab|bitbucket|gist):(.+)$/);
    const hosted = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org', gist: 'gist.github.com' };
    const repo = shorthand ? `${hosted[shorthand[1]]}/${shorthand[2]}` : raw;
    let url;
    try {
      const scp = repo.match(/^[^/@]+@([^/:]+):(.+)$/);
      url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : repo.includes('://') ? repo : `https://${repo}`);
    } catch { throw new Error('Unrecognized Git package source.'); }
    const path = url.pathname.replace(/^\/+|\/+$/g, '').split('@', 1)[0].replace(/\.git$/, '');
    if (!path) throw new Error('Git package source is missing a repository path.');
    return { id: `git:${url.hostname}/${path}`, name: basename(path), source };
  }
  const path = resolve(base, value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value);
  // Keep the spelling Pi uses to match declarations; only use a real path to protect ourselves.
  const keyPath = process.platform === 'win32' ? path.toLowerCase() : path;
  return { id: `local:${keyPath}`, name: basename(path), source, path };
}

export function isManager(info, ownRoot) {
  if (info.id === 'git:github.com/outmost9271/pi-ext' || info.id === 'npm:pi-ext') return true;
  if (!info.path || !ownRoot) return false;
  try {
    const path = realpathSync(info.path);
    const root = realpathSync(ownRoot);
    return path === root || path.startsWith(root + sep);
  } catch { return false; }
}

export function packages(settings) {
  const entries = settings.packages === undefined ? [] : settings.packages;
  if (!Array.isArray(entries) || entries.some((p) => typeof p !== 'string' && (!object(p) || typeof p.source !== 'string'))) {
    throw new Error('Invalid Pi packages configuration. No changes made.');
  }
  return entries;
}

function nativeEntry(entry) {
  const { [META]: _metadata, ...native } = entry;
  return native;
}

function marker(entry) {
  if (!object(entry) || !Object.hasOwn(entry, META)) return undefined;
  const metadata = entry[META];
  if (!object(metadata) || metadata.version !== 1 || !['enable', 'disable'].includes(metadata.mode)
    || !(metadata.previous === null || typeof metadata.previous === 'string' || (object(metadata.previous)
      && typeof metadata.previous.source === 'string' && !Object.hasOwn(metadata.previous, META)))
    || !isDeepStrictEqual(nativeEntry(entry), metadata.applied)) return null;
  return metadata;
}

function wrap(applied, mode, previous) {
  return { ...applied, [META]: { version: 1, mode, previous: previous ?? null, applied } };
}

export function status(entry) {
  if (typeof entry === 'string') return 'Enabled';
  const managed = marker(entry);
  if (managed === null) return 'Edited externally';
  if (entry.autoload !== false && TYPES.every((type) => Array.isArray(entry[type]) && entry[type].length === 0)) return 'Disabled';
  if (managed?.mode === 'disable') return 'Disabled';
  return entry.autoload === false || TYPES.some((type) => entry[type] !== undefined) ? 'Partially enabled' : 'Enabled';
}

export function projectStatus(entry) {
  if (!entry) return 'Inherit';
  const managed = marker(entry);
  if (managed === null) return 'Edited externally';
  if (!managed) return 'Native settings';
  return managed.mode === 'enable' ? 'Explicitly enabled' : 'Explicitly disabled';
}

export function effectiveStatus(global, project) {
  if (!project) return status(global);
  if (marker(project)?.mode === 'disable') return 'Disabled';
  if (project.autoload === false) return 'Per-resource override';
  return status(project);
}

export function listPackages(user, project, userDir, projectDir) {
  const projects = packages(project).map((entry) => ({ entry, ...sourceInfo(sourceOf(entry), projectDir) }));
  const counts = new Map();
  const rows = packages(user).map((global, index) => {
    const info = sourceInfo(sourceOf(global), userDir);
    const matching = projects.filter((item) => item.id === info.id);
    counts.set(info.id, (counts.get(info.id) ?? 0) + 1);
    return { ...info, global, index, project: matching[0]?.entry, ambiguousProject: matching.length > 1 };
  });
  return rows.map((row) => ({ ...row, ambiguousGlobal: counts.get(row.id) > 1 }));
}

export function selectPackage(rows, target) {
  const exact = rows.filter((row) => [row.id, row.source].includes(target));
  const matches = exact.length ? exact : rows.filter((row) => row.name === target);
  if (matches.length !== 1 || matches[0].ambiguousGlobal) {
    throw new Error(matches.length ? 'Ambiguous package. Use the full source, or remove duplicate declarations first.' : 'User-installed package not found.');
  }
  return matches[0];
}

function assertManageable(info) {
  if (!info.path) return;
  let directory = false;
  try { directory = statSync(info.path).isDirectory(); } catch { /* missing */ }
  if (!directory) throw new Error('Pi cannot filter single-file extensions or missing local packages. No changes made.');
}

function enabled(entry) {
  if (typeof entry === 'string') return { source: entry };
  if (entry.autoload === false) throw new Error('Cannot replace existing native delta filters safely. Adjust them with pi config first.');
  if (status(entry) !== 'Disabled') return { ...entry };
  const result = { ...entry };
  for (const type of TYPES) delete result[type];
  return result;
}

export function transition(row, { scope, verb }) {
  const local = scope === 'project';
  if (local && row.ambiguousProject) throw new Error('Remove duplicate project declarations first.');
  const current = local ? row.project : row.global;
  const managed = marker(current);
  if (managed === null) throw new Error('This entry was edited externally. Reconcile the Pi settings before changing it.');
  if (verb === 'inherit') return managed ? managed.previous : current;
  if (managed?.mode === verb) return current;
  assertManageable(row);
  const original = managed ? managed.previous : current;
  if (!local) {
    if (verb === 'enable') {
      if (managed?.mode === 'disable') return original;
      return status(current) === 'Disabled' ? enabled(current) : current;
    }
    if (status(current) === 'Disabled') return current;
    return wrap({ ...(object(current) ? current : { source: current }), autoload: true, ...filters([]) }, verb, current);
  }
  if (verb === 'disable') {
    // A project delta can suppress the user installation without cloning it into the project.
    return wrap({ source: row.path ?? row.source, autoload: false, ...filters(['!**']) }, verb, original);
  }
  const globalMarker = marker(row.global);
  if (globalMarker === null && !original) throw new Error('The global entry was edited externally. The original filters cannot be determined safely.');
  const base = original ?? globalMarker?.previous ?? row.global;
  const native = enabled(base);
  const source = original ? sourceOf(original) : row.path ?? row.source;
  return wrap({ ...native, source }, verb, original);
}

export function replacePackage(settings, index, next) {
  const entries = [...packages(settings)];
  if (index === -1) {
    if (next == null) return settings;
    entries.push(next);
  } else if (next == null) entries.splice(index, 1);
  else if (isDeepStrictEqual(entries[index], next)) return settings;
  else entries[index] = next;
  if (entries.length) return { ...settings, packages: entries };
  const { packages: _packages, ...rest } = settings;
  return rest;
}

async function readRaw(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function loadSettings(path) {
  const raw = await readRaw(path);
  try {
    const value = raw === undefined ? {} : JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (!object(value)) throw new Error();
    packages(value);
    return { raw, value };
  } catch { throw new Error(`Cannot parse settings at ${path}. No changes made.`); }
}

export async function canonicalSettings(path, projectRoot) {
  const dir = dirname(path);
  const actual = await realpath(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return realpath(dir).then((parent) => join(parent, basename(path)), (parentError) => {
      if (parentError.code !== 'ENOENT') throw parentError;
      return path;
    });
  });
  if (projectRoot) {
    const difference = relative(await realpath(projectRoot), actual);
    if (!difference || isAbsolute(difference) || difference === '..' || difference.startsWith(`..${sep}`)) {
      throw new Error('Project settings point outside the project directory. No changes made.');
    }
  }
  return actual;
}

export async function saveSettings(path, raw, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.pi-ext-${randomUUID()}.tmp`);
  const mode = raw === undefined ? 0o600 : (await stat(path)).mode & 0o777;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode });
    if (await readRaw(path) !== raw) throw new Error('Another process changed the settings. Try again.');
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
