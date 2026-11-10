'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 解析本机已安装桌面便签的启动 EXE。
// 优先级：设置里已配置且真实存在的 EXE → 桌面 / 用户开始菜单中名字含“便签/sticky”的快捷方式解析出的真实 EXE。
// 只认可真实存在的可执行文件，绝不回退到源码包（便签/ desktop_note）或猜测的解包目录。

const isExe = file => typeof file === 'string' && /\.exe$/i.test(file);
const exists = file => { try { fs.accessSync(file, fs.constants.F_OK); return true; } catch { return false; } };
const usableExe = file => isExe(file) && exists(file);
const stickyNamed = name => /便签|sticky/i.test(name);

function shortcutLinks({ desktopDir, appData }) {
  const roots = [];
  if (desktopDir) roots.push(desktopDir);
  if (appData) roots.push(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  const links = [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root, { recursive: true }); } catch { continue; }
    for (const entry of entries) if (/\.lnk$/i.test(entry)) links.push(path.join(root, entry));
  }
  return links;
}

function linkTarget(readShortcutLink, link) {
  try {
    const resolved = readShortcutLink(link);
    const target = resolved && typeof resolved.target === 'string' ? resolved.target : '';
    return target ? path.resolve(target) : '';
  } catch { return ''; } // 无法解析或目标为空的快捷方式直接跳过
}

/**
 * 解析可启动的已安装便签 EXE。
 * @param {object} input
 * @param {string} [input.noteExePath] 设置中手动指定的 EXE；空/未填表示自动查找。
 * @param {string} [input.desktopDir] 注入的 app.getPath('desktop')。
 * @param {(file: string) => {target: string}} [input.readShortcutLink] 注入的 shell.readShortcutLink。
 * @param {string} [input.appData] 注入的 %APPDATA%，用于用户开始菜单目录。
 * @returns {{ exe: string, source: 'configured'|'shortcut' }} source 标明路径来源。
 * @throws 配置路径无效或找不到已安装便签时抛出可直接展示的错误。
 */
function resolveInstalledNoteExe({ noteExePath, desktopDir, readShortcutLink, appData } = {}) {
  if (typeof noteExePath === 'string' && noteExePath.trim()) {
    const configured = path.resolve(noteExePath.trim());
    if (!usableExe(configured)) {
      throw new Error(`设置的便签程序不存在或不是EXE：${configured}。请在设置中更新，或清空后自动查找`);
    }
    return { exe: configured, source: 'configured' };
  }
  if (typeof readShortcutLink !== 'function') throw new Error('当前环境无法查找已安装便签的快捷方式');
  for (const link of shortcutLinks({ desktopDir, appData })) {
    const target = linkTarget(readShortcutLink, link);
    if (!usableExe(target)) continue;
    // 只认名字指向便签的快捷方式，避免误启动桌面上无关程序。
    if (stickyNamed(path.basename(link)) || stickyNamed(path.basename(target))) {
      return { exe: target, source: 'shortcut' };
    }
  }
  throw new Error('未找到已安装的桌面便签。请先安装并至少打开一次便签，或在设置中手动指定便签EXE路径');
}

module.exports = { resolveInstalledNoteExe };
