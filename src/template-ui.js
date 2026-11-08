const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { TemplateStore, validatePath } = require('./templates');

/** @typedef {import('./templates').Group} Group */
/** @typedef {{name: string, path: string, type: 'group' | 'directory' | 'file', revision: string}} TemplateNode */

/** @param {string} name @param {string} itemPath */
function templateUri(name, itemPath) {
  return vscode.Uri.from({ scheme: 'vstemplater', authority: Buffer.from(name).toString('hex'), path: `/${itemPath}` });
}

/** @param {Group} group @param {string} prefix @returns {TemplateNode[]} */
function children(group, prefix) {
  const start = prefix ? `${prefix}/` : '';
  /** @type {Map<string, TemplateNode>} */
  const nodes = new Map();
  for (const entry of group.entries) {
    if (!entry.path.startsWith(start)) continue;
    const relative = entry.path.slice(start.length);
    if (!relative) continue;
    const name = relative.split('/')[0];
    const itemPath = start + name;
    nodes.set(itemPath, { name: group.name, path: itemPath, revision: group.revision,
      type: relative.includes('/') || entry.type === 'directory' ? 'directory' : 'file' });
  }
  return [...nodes.values()].sort((a, b) => Number(a.type === 'file') - Number(b.type === 'file') ||
    a.path.localeCompare(b.path));
}

/** @implements {vscode.TreeDataProvider<TemplateNode>} */
class TemplatesTree {
  /** @param {TemplateStore} store */
  constructor(store) {
    this.store = store;
    this.changes = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changes.event;
  }

  refresh() { this.changes.fire(undefined); }
  dispose() { this.changes.dispose(); }

  /** @param {TemplateNode} node */
  getTreeItem(node) {
    const item = new vscode.TreeItem(node.type === 'group' ? node.name : path.posix.basename(node.path),
      node.type === 'file' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = JSON.stringify([node.name, node.path]);
    item.contextValue = node.type === 'group' ? 'templateGroup' : node.type === 'file' ? 'templateFile' : 'templateFolder';
    item.tooltip = node.path ? `${node.name}: ${node.path}` : node.name;
    item.iconPath = new vscode.ThemeIcon(node.type === 'group' ? 'library' : node.type === 'file' ? 'file' : 'folder');
    if (node.type !== 'group') item.resourceUri = templateUri(node.name, node.path);
    if (node.type === 'file') item.command = { command: 'vstemplater.edit', title: 'Edit Template File', arguments: [node] };
    return item;
  }

  /** @param {TemplateNode} [node] @returns {Promise<TemplateNode[]>} */
  async getChildren(node) {
    if (!node) return (await this.store.list()).map(group => ({ name: group.name, path: '', type: 'group', revision: group.revision }));
    if (node.type === 'file') return [];
    const group = await this.store.get(node.name);
    return group ? children(group, node.path) : [];
  }
}

/** @implements {vscode.FileSystemProvider} */
class TemplateFiles {
  /** @param {TemplateStore} store @param {() => void} changed */
  constructor(store, changed) {
    this.store = store;
    this.changed = changed;
    /** @type {Map<string, string>} */
    this.opened = new Map();
    /** @type {vscode.EventEmitter<vscode.FileChangeEvent[]>} */
    this.changes = new vscode.EventEmitter();
    this.onDidChangeFile = this.changes.event;
  }

  dispose() { this.changes.dispose(); }
  watch() { return new vscode.Disposable(() => {}); }

  /** @param {vscode.Uri} uri */
  async lookup(uri) {
    const name = Buffer.from(uri.authority, 'hex').toString('utf8');
    if (uri.scheme !== 'vstemplater' || Buffer.from(name).toString('hex') !== uri.authority) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const itemPath = uri.path.slice(1);
    if (itemPath) validatePath(itemPath);
    const group = await this.store.get(name);
    if (!group) throw vscode.FileSystemError.FileNotFound(uri);
    const entry = group.entries.find(entry => entry.path === itemPath);
    if (itemPath && !entry && !group.entries.some(entry => entry.path.startsWith(`${itemPath}/`))) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return { group, entry, itemPath };
  }

  /** @param {vscode.Uri} uri */
  async stat(uri) {
    const { group, entry } = await this.lookup(uri);
    const info = await fs.stat(this.store.filename(group.name));
    return { type: entry?.type === 'file' ? vscode.FileType.File : vscode.FileType.Directory,
      ctime: info.birthtimeMs, mtime: info.mtimeMs, size: entry?.content ? Buffer.from(entry.content, 'base64').length : 0 };
  }

  /** @param {vscode.Uri} uri @returns {Promise<[string, vscode.FileType][]>} */
  async readDirectory(uri) {
    const { group, itemPath, entry } = await this.lookup(uri);
    if (entry?.type === 'file') throw vscode.FileSystemError.FileNotADirectory(uri);
    return children(group, itemPath).map(node => [path.posix.basename(node.path),
      node.type === 'file' ? vscode.FileType.File : vscode.FileType.Directory]);
  }

  /** @param {vscode.Uri} uri */
  async readFile(uri) {
    const { entry } = await this.lookup(uri);
    if (entry?.type !== 'file') throw vscode.FileSystemError.FileIsADirectory(uri);
    this.opened.set(uri.toString(), entry.content || '');
    return Buffer.from(entry.content || '', 'base64');
  }

  /** @param {vscode.Uri} uri @param {Uint8Array} content @param {{create: boolean, overwrite: boolean}} options */
  async writeFile(uri, content, options) {
    const { group, entry, itemPath } = await this.lookup(uri);
    if (entry?.type !== 'file') throw vscode.FileSystemError.FileIsADirectory(uri);
    if (!options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    const baseline = this.opened.get(uri.toString());
    if (baseline === undefined || baseline !== entry.content) {
      throw vscode.FileSystemError.NoPermissions('This template file changed since it was opened. Copy your edits, then reopen the file before saving.');
    }
    await this.store.edit(group, itemPath, content);
    this.opened.set(uri.toString(), Buffer.from(content).toString('base64'));
    this.changes.fire([{ type: vscode.FileChangeType.Changed, uri }]);
    this.changed();
  }

  createDirectory() { throw vscode.FileSystemError.NoPermissions('Use Add to Templates to add folders.'); }
  delete() { throw vscode.FileSystemError.NoPermissions('Use Delete in the Templates view.'); }
  rename() { throw vscode.FileSystemError.NoPermissions('Use Rename in the Templates view.'); }
}

module.exports = { TemplatesTree, TemplateFiles, templateUri };
