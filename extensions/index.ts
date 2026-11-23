import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_DIR_NAME, CustomEditor, getAgentDir, withFileMutationQueue,
  type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { Input, SelectList, truncateToWidth } from '@earendil-works/pi-tui';
import {
  canonicalSettings, effectiveStatus, isManager, listPackages, loadSettings, packages,
  parseCommand, projectStatus, replacePackage, saveSettings, selectPackage, sourceInfo, sourceOf,
  status, transition, usage,
} from '../src/config.mjs';
import { availableScopes, completeArguments } from '../src/completion.mjs';

type Row = ReturnType<typeof listPackages>[number];
type Command = NonNullable<ReturnType<typeof parseCommand>>;
const root = fileURLToPath(new URL('../', import.meta.url));

function configPaths(ctx: ExtensionContext) {
  const userDir = getAgentDir();
  return { userDir, global: join(userDir, 'settings.json'), project: join(ctx.cwd, CONFIG_DIR_NAME, 'settings.json') };
}

async function rowsFor(ctx: ExtensionContext) {
  const paths = configPaths(ctx);
  const user = await loadSettings(paths.global);
  const project = ctx.isProjectTrusted() ? await loadSettings(await canonicalSettings(paths.project, ctx.cwd)) : { value: {} };
  return listPackages(user.value, project.value, paths.userDir, ctx.cwd);
}

async function choosePackage(ctx: ExtensionCommandContext, rows: Row[]) {
  return ctx.ui.custom<Row | undefined>((tui, theme, keys, done) => {
    const input = new Input();
    const entries = rows.map((row, index) => ({
      value: String(index),
      label: `${row.name}${isManager(row, root) ? ' (manager)' : ''} | ${status(row.global)} / ${ctx.isProjectTrusted() ? projectStatus(row.project) : 'Untrusted'} / ${effectiveStatus(row.global, row.project)}`,
      description: row.source,
    }));
    const makeList = (query: string) => {
      const visible = entries.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query));
      const list = new SelectList(visible, Math.min(10, Math.max(1, visible.length)), {
        selectedPrefix: (s) => theme.fg('accent', s), selectedText: (s) => theme.fg('accent', s),
        description: (s) => theme.fg('muted', s), scrollInfo: (s) => theme.fg('dim', s),
        noMatch: (s) => theme.fg('warning', s),
      });
      list.onSelect = (item) => done(rows[Number(item.value)]);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = makeList('');
    return {
      capturesViewportInput: true,
      get focused() { return input.focused; },
      set focused(value) { input.focused = value; },
      render(width: number) {
        return [
          truncateToWidth(theme.fg('accent', 'Extensions | Global / Project / Effective'), width),
          ...input.render(width), ...list.render(width),
          truncateToWidth(theme.fg('dim', 'Type to search · ↑↓ Select · Enter Actions · Esc Back'), width),
        ];
      },
      invalidate() { input.invalidate(); list.invalidate(); },
      handleInput(data: string) {
        if (['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel', 'tui.select.pageUp', 'tui.select.pageDown'].some((key) => keys.matches(data, key))) {
          list.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) list = makeList(input.getValue().trim().toLowerCase());
        }
        tui.requestRender();
      },
    };
  }, { blocked: { kind: 'question', message: 'Select a package to manage' } });
}

async function apply(ctx: ExtensionCommandContext, command: Command): Promise<boolean> {
  const local = command.scope === 'project';
  if (local && !ctx.isProjectTrusted()) throw new Error('This project is not trusted. Project settings cannot be changed.');
  const paths = configPaths(ctx);
  const globalFile = await canonicalSettings(paths.global);
  const file = local ? await canonicalSettings(paths.project, ctx.cwd) : globalFile;
  if (local && file === globalFile) throw new Error('Project and global settings point to the same file. No changes made.');
  return withFileMutationQueue(file, async () => {
    const target = await loadSettings(file);
    const user = local ? await loadSettings(globalFile) : target;
    const project = local ? target.value : {};
    const row = selectPackage(listPackages(user.value, project, paths.userDir, ctx.cwd), command.target);
    if (isManager(row, root)) throw new Error('pi-ext cannot manage itself. Use Pi settings instead.');
    const next = transition(row, command);
    const index = local
      ? packages(project).findIndex((entry) => sourceInfo(sourceOf(entry), ctx.cwd).id === row.id)
      : row.index;
    const updated = replacePackage(target.value, index, next);
    if (updated === target.value) return false;
    await saveSettings(file, target.raw, updated);
    return true;
  });
}

export default function extension(pi: ExtensionAPI) {
  let session: ExtensionContext | undefined;
  pi.on('session_start', (_event, ctx) => {
    session = ctx;
    if (ctx.mode !== 'tui') return;
    const inArguments = (lines: string[], line: number, col: number) =>
      line === 0 && /^\s*\/extensions /.test((lines[line] ?? '').slice(0, col));
    const atEnd = (lines: string[], line: number, col: number) =>
      lines.length === 1 && col === lines[line]?.length;
    let refreshEditor: ((text: string, line: number, col: number) => void) | undefined;
    let completionRefreshPending = false;
    ctx.ui.addAutocompleteProvider((base) => ({
      triggerCharacters: base.triggerCharacters,
      getSuggestions(lines, line, col, options) {
        if (!inArguments(lines, line, col)) return base.getSuggestions(lines, line, col, options);
        // Pi's forced Tab path otherwise tries filename completion for command arguments.
        if (!atEnd(lines, line, col)) return null;
        return base.getSuggestions(lines, line, col, { ...options, force: false });
      },
      applyCompletion(lines, line, col, item, prefix) {
        const result = base.applyCompletion(lines, line, col, item, prefix);
        if (inArguments(result.lines, result.cursorLine, result.cursorCol)
          && atEnd(result.lines, result.cursorLine, result.cursorCol)) {
          const text = result.lines.join('\n');
          // Run after Pi applies the selection and closes the old menu. This also handles mouse and Enter.
          completionRefreshPending = true;
          queueMicrotask(() => {
            completionRefreshPending = false;
            refreshEditor?.(text, result.cursorLine, result.cursorCol);
          });
        }
        return result;
      },
      shouldTriggerFileCompletion(lines, line, col) {
        return inArguments(lines, line, col) || (base.shouldTriggerFileCompletion?.(lines, line, col) ?? true);
      },
    }));
    const previous = ctx.ui.getEditorComponent();
    ctx.ui.setEditorComponent((tui, theme, keys) => {
      const editor = previous?.(tui, theme, keys) ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
      // Pi 1.6 has no public request for a regular refresh; a forced Tab can insert a lone match.
      const compatible = editor as typeof editor & {
        getCursor?: () => { line: number; col: number };
        tryTriggerAutocomplete?: () => void;
      };
      if (typeof compatible.tryTriggerAutocomplete !== 'function' || typeof compatible.getCursor !== 'function') return editor;
      refreshEditor = (text, line, col) => {
        const cursor = compatible.getCursor?.();
        if (!editor.capturesViewportInput && editor.getText() === text && cursor?.line === line && cursor.col === col) {
          compatible.tryTriggerAutocomplete?.();
        }
      };
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        const before = editor.getText();
        const previousCursor = compatible.getCursor?.();
        handleInput(data);
        const after = editor.getText();
        const cursor = compatible.getCursor?.();
        if (!completionRefreshPending && cursor && (before !== after
          || cursor.line !== previousCursor?.line || cursor.col !== previousCursor?.col)) {
          const lines = after.split('\n');
          if (!inArguments(lines, cursor.line, cursor.col) || !atEnd(lines, cursor.line, cursor.col)) return;
          // Covers whitespace, quotes, deletion and paste when the native menu was closed.
          refreshEditor?.(after, cursor.line, cursor.col);
        }
      };
      return editor;
    });
  });
  pi.on('session_shutdown', () => { session = undefined; });

  pi.registerCommand('extensions', {
    description: 'Manage package loading globally and per project (enable, disable, inherit, --help)',
    getArgumentCompletions: async (prefix) => {
      if (!/^(enable|disable|inherit)\s/.test(prefix.trimStart())) return completeArguments(prefix);
      try {
        const ctx = session;
        if (!ctx) return null;
        return completeArguments(prefix, await rowsFor(ctx), {
          projectTrusted: ctx.isProjectTrusted(),
          isAvailable: (row: Row) => !isManager(row, root),
        });
      } catch {
        return null;
      }
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/extensions requires interactive mode.', 'error');
        return;
      }
      let shouldReload = false;
      try {
        if (args.trim() === '--help') { ctx.ui.notify(usage, 'info'); return; }
        let command = parseCommand(args);
        if (!command) {
          const rows = await rowsFor(ctx);
          if (!rows.length) { ctx.ui.notify('No user-installed packages found.', 'info'); return; }
          while (!command) {
            const row = await choosePackage(ctx, rows);
            if (!row) return;
            if (isManager(row, root)) { ctx.ui.notify('pi-ext is the manager and cannot disable itself.', 'info'); continue; }
            const trusted = ctx.isProjectTrusted();
            const actions: Record<string, Omit<Command, 'target'>> = {};
            for (const verb of ['enable', 'disable'] as const) {
              for (const scope of availableScopes(row, verb, trusted)) {
                const label = `${scope === 'global' ? 'Global' : 'Project'}: ${verb === 'enable' ? 'Enable' : 'Disable'}`;
                actions[label] = { verb, scope };
              }
            }
            if (trusted && row.project) actions['Project: Follow global setting'] = { verb: 'inherit', scope: 'project' };
            if (!Object.keys(actions).length) { ctx.ui.notify('No actions available for this package.', 'info'); continue; }
            const action = await ctx.ui.select(row.source, Object.keys(actions));
            if (action) command = { ...actions[action], target: row.id };
          }
        }
        if (!await apply(ctx, command)) { ctx.ui.notify('No settings changed.', 'info'); return; }
        ctx.ui.notify('Settings saved.', 'info');
        shouldReload = await ctx.ui.confirm('Reload now?', 'Choose No to apply on /reload or on the next launch.');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
      if (shouldReload) { await ctx.reload(); return; }
    },
  });
}
