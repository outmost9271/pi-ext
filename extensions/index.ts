import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_DIR_NAME, getAgentDir, withFileMutationQueue,
  type ExtensionAPI, type ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import { Input, SelectList, truncateToWidth } from '@earendil-works/pi-tui';
import {
  canonicalSettings, effectiveStatus, isManager, listPackages, loadSettings, packages,
  parseCommand, projectStatus, replacePackage, saveSettings, selectPackage, sourceInfo, sourceOf,
  status, transition,
} from '../src/config.mjs';

type Row = ReturnType<typeof listPackages>[number];
type Command = NonNullable<ReturnType<typeof parseCommand>>;
const root = fileURLToPath(new URL('../', import.meta.url));

function configPaths(ctx: ExtensionCommandContext) {
  const userDir = getAgentDir();
  return { userDir, global: join(userDir, 'settings.json'), project: join(ctx.cwd, CONFIG_DIR_NAME, 'settings.json') };
}

async function rowsFor(ctx: ExtensionCommandContext) {
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
      label: `${row.name}${isManager(row, root) ? '（管理器）' : ''} ｜ ${status(row.global)} / ${ctx.isProjectTrusted() ? projectStatus(row.project) : '不受信任'} / ${effectiveStatus(row.global, row.project)}`,
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
          truncateToWidth(theme.fg('accent', '插件管理　｜　全局 / 项目 / 配置有效状态'), width),
          ...input.render(width), ...list.render(width),
          truncateToWidth(theme.fg('dim', '输入搜索 · ↑↓ 选择 · Enter 打开操作 · Esc 返回'), width),
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
  }, { blocked: { kind: 'question', message: '选择要管理的插件' } });
}

async function apply(ctx: ExtensionCommandContext, command: Command): Promise<boolean> {
  const local = command.scope === 'project';
  if (local && !ctx.isProjectTrusted()) throw new Error('当前项目不受信任，不能修改项目设置');
  const paths = configPaths(ctx);
  const globalFile = await canonicalSettings(paths.global);
  const file = local ? await canonicalSettings(paths.project, ctx.cwd) : globalFile;
  if (local && file === globalFile) throw new Error('项目与全局配置指向同一个文件，未作修改');
  return withFileMutationQueue(file, async () => {
    const target = await loadSettings(file);
    const user = local ? await loadSettings(globalFile) : target;
    const project = local ? target.value : {};
    const row = selectPackage(listPackages(user.value, project, paths.userDir, ctx.cwd), command.target);
    if (isManager(row, root)) throw new Error('pi-ext 不允许管理自身；可用 Pi 原生配置调整');
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
  pi.registerCommand('extensions', {
    description: '管理已安装软件包的全局开关和项目覆盖',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui') {
        ctx.ui.notify('/extensions 需要交互式终端', 'error');
        return;
      }
      let shouldReload = false;
      try {
        let command = parseCommand(args);
        if (!command) {
          const rows = await rowsFor(ctx);
          if (!rows.length) { ctx.ui.notify('没有用户级安装的软件包', 'info'); return; }
          while (!command) {
            const row = await choosePackage(ctx, rows);
            if (!row) return;
            if (isManager(row, root)) { ctx.ui.notify('pi-ext 是管理器，不提供自禁用操作', 'info'); continue; }
            const actions: Record<string, Omit<Command, 'target'>> = {
              '全局：启用': { verb: 'enable', scope: 'global' },
              '全局：禁用': { verb: 'disable', scope: 'global' },
            };
            if (ctx.isProjectTrusted()) Object.assign(actions, {
              '项目：显式启用': { verb: 'enable', scope: 'project' },
              '项目：显式禁用': { verb: 'disable', scope: 'project' },
              '项目：恢复跟随全局': { verb: 'inherit', scope: 'project' },
            });
            const action = await ctx.ui.select(row.source, Object.keys(actions));
            if (action) command = { ...actions[action], target: row.id };
          }
        }
        if (!await apply(ctx, command)) { ctx.ui.notify('配置无需修改', 'info'); return; }
        ctx.ui.notify('配置已保存', 'info');
        shouldReload = await ctx.ui.confirm('立即重载？', '选择否可稍后使用 /reload，或在下次启动时生效。');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
      if (shouldReload) { await ctx.reload(); return; }
    },
  });
}
