const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TemplateStore, collect, importEntries, inspectImport, writeImport, validatePath, selectItem } = require('./templates');
const { TemplatesTree, TemplateFiles, templateUri } = require('./template-ui');
const { registerSync } = require('./sync');

/** @typedef {import('./template-ui').TemplateNode} TemplateNode */

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const store = new TemplateStore(path.join(context.globalStorageUri.fsPath, 'templates'));
  const tree = new TemplatesTree(store);
  registerSync(context, store, () => tree.refresh());
  const files = new TemplateFiles(store, () => tree.refresh());
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.globalStorageUri, 'templates/*.json'));
  context.subscriptions.push(tree, files, watcher,
    vscode.window.registerTreeDataProvider('vstemplater.templates', tree),
    vscode.workspace.registerFileSystemProvider('vstemplater', files, { isCaseSensitive: true }),
    watcher.onDidChange(() => tree.refresh()), watcher.onDidCreate(() => tree.refresh()), watcher.onDidDelete(() => tree.refresh()),
    vscode.commands.registerCommand('vstemplater.refresh', () => tree.refresh()));
  let busy = false;
  register('vstemplater.add', true, add);
  register('vstemplater.import', true, importTemplate);
  register('vstemplater.importItem', true, async (/** @type {TemplateNode} */ node) => importTemplate(undefined, node));
  register('vstemplater.rename', false, rename);
  register('vstemplater.delete', false, remove);
  register('vstemplater.edit', false, async (/** @type {TemplateNode} */ node) => {
    const group = await selectedGroup(node);
    if (!group.entries.some(entry => entry.path === node.path && entry.type === 'file')) throw new Error('Select a template file.');
    await vscode.commands.executeCommand('vscode.open', templateUri(group.name, node.path));
  });

  /** @template T @param {string} id @param {boolean} requiresProject @param {(argument: T) => Promise<unknown>} action */
  function register(id, requiresProject, action) {
    context.subscriptions.push(vscode.commands.registerCommand(id, async (uri) => {
      if (requiresProject && !vscode.workspace.workspaceFolders?.length) {
        void vscode.window.showErrorMessage('Open a project first.');
        return;
      }
      if (requiresProject && !vscode.workspace.isTrusted) {
        void vscode.window.showErrorMessage('Trust this workspace before using templates.');
        return;
      }
      if (busy) {
        void vscode.window.showInformationMessage('A template operation is already running.');
        return;
      }
      busy = true;
      try { await action(uri); }
      catch (error) { void vscode.window.showErrorMessage(`Templates: ${/** @type {Error} */ (error).message}`); }
      finally { busy = false; }
    }));
  }

  /** @param {TemplateNode} node */
  async function selectedGroup(node) {
    if (!node?.name) throw new Error('Select an item in the Templates view.');
    const group = await store.get(node.name);
    if (!group || group.revision !== node.revision) {
      tree.refresh();
      throw new Error('This template changed. Refresh the Templates view and select it again.');
    }
    return group;
  }

  /** @param {TemplateNode} node */
  function ensureClean(node) {
    const authority = templateUri(node.name, '').authority;
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'vstemplater' &&
        document.uri.authority === authority && (!node.path || document.uri.path === `/${node.path}` || document.uri.path.startsWith(`/${node.path}/`)))) {
      throw new Error('Save or close unsaved template files before renaming or deleting this item.');
    }
  }

  /** @param {TemplateNode} node */
  async function rename(node) {
    const group = await selectedGroup(node);
    ensureClean(node);
    const name = await vscode.window.showInputBox({ prompt: node.path ? 'New item name' : 'New group name',
      value: node.path ? path.posix.basename(node.path) : node.name, ignoreFocusOut: true,
      validateInput: value => {
        if (!value.trim() || /[\x00-\x1f]/.test(value)) return 'Enter a valid name.';
        if (node.path) {
          try { validatePath(value.trim()); }
          catch { return 'Enter a valid file or folder name.'; }
          if (value.includes('/')) return 'Enter a name, not a path.';
        }
        return undefined;
      } });
    if (name === undefined) return;
    ensureClean(node);
    await store.rename(group, node.path, name);
    tree.refresh();
  }

  /** @param {TemplateNode} node */
  async function remove(node) {
    const group = await selectedGroup(node);
    ensureClean(node);
    const label = node.path || node.name;
    if (await vscode.window.showWarningMessage(`Delete "${label}" from templates?`,
      { modal: true, detail: node.path ? 'The selected item and its contents will be removed from this template group.' :
        'The entire template group will be permanently removed.' }, 'Delete') !== 'Delete') return;
    ensureClean(node);
    await store.remove(group, node.path);
    tree.refresh();
  }

  /** @param {vscode.Uri | undefined} uri */
  async function projectFor(uri) {
    if (uri && uri.scheme !== 'file') throw new Error('Only local projects are supported.');
    const folders = vscode.workspace.workspaceFolders || [];
    const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : folders.length === 1 ? folders[0] :
      await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select a project' });
    if (!folder) {
      if (uri) throw new Error('Select an item inside an open project.');
      return;
    }
    if (folder.uri.scheme !== 'file') throw new Error('Only local projects are supported.');
    return folder;
  }

  /** @param {vscode.Uri | undefined} uri */
  async function add(uri) {
    const project = await projectFor(uri);
    if (!project) return;
    if (!uri) {
      const selected = await vscode.window.showOpenDialog({ defaultUri: project.uri, canSelectFiles: true,
        canSelectFolders: true, canSelectMany: false, openLabel: 'Add to Templates' });
      uri = selected?.[0];
      if (!uri) return;
      if (uri.scheme !== 'file') throw new Error('Select a local file or folder.');
    }
    const groups = await store.list();
    const selected = await vscode.window.showQuickPick([
      { label: '$(add) Create new template group', name: undefined },
      ...groups.map(group => ({ label: group.name, name: group.name }))
    ], { placeHolder: 'Select a template group or create a new one' });
    if (!selected) return;
    const input = selected.name ?? await vscode.window.showInputBox({ prompt: 'Template group name',
      ignoreFocusOut: true, validateInput: value => !value.trim() || /[\x00-\x1f]/.test(value) ? 'Enter a valid name.' : undefined });
    if (input === undefined) return;
    const name = input.trim().normalize('NFC');
    const previous = await store.get(name);
    const addition = await collect(project.uri.fsPath, uri.fsPath);
    if (!addition.entries.length) throw new Error('No eligible files or folders to add.');
    const previousPaths = new Map(previous?.entries.map(entry => [entry.path, entry]) || []);
    const collisions = addition.entries.filter(entry => previousPaths.has(entry.path) &&
      (entry.type === 'file' || previousPaths.get(entry.path)?.type !== entry.type));
    if (collisions.length && await vscode.window.showWarningMessage(
      `Replace ${collisions.length} existing item(s) in "${name}"?`,
      { modal: true, detail: collisions.map(entry => entry.path).slice(0, 20).join('\n') }, 'Replace') !== 'Replace') return;
    await store.save(name, addition, previous?.revision);
    tree.refresh();
    void vscode.window.showInformationMessage(`Saved to "${name}".${addition.skipped.length ? ` Skipped ${addition.skipped.length} excluded path(s).` : ''}`);
  }

  /** @param {vscode.Uri | undefined} uri @param {TemplateNode} [node] */
  async function importTemplate(uri, node) {
    const project = await projectFor(uri);
    if (!project) return;
    let group;
    if (node) group = selectItem(await selectedGroup(node), node.path);
    else {
      const groups = await store.list();
      if (!groups.length) {
        void vscode.window.showInformationMessage('No templates yet. Use Add to Templates first.');
        return;
      }
      const selected = await vscode.window.showQuickPick(groups.map(group => ({ label: group.name,
        description: `${group.roots.length} root item(s)`, group })), { placeHolder: 'Select a template to import' });
      if (!selected) return;
      group = selected.group;
    }
    if (!group.entries.length) {
      void vscode.window.showInformationMessage('This template group is empty.');
      return;
    }
    const mode = await vscode.window.showQuickPick([
      { label: 'Keep original paths', description: 'Recreate saved paths under the destination', original: true },
      { label: 'Choose a new path', description: 'Choose a destination; a single saved item loses its parent path', original: false }
    ], { placeHolder: 'How should template paths be imported?' });
    if (!mode) return;
    let destination;
    if (uri && mode.original) {
      destination = (await fs.stat(uri.fsPath)).isDirectory() ? uri.fsPath : path.dirname(uri.fsPath);
    } else {
      const selectedDestination = await vscode.window.showOpenDialog({ defaultUri: uri || project.uri,
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Import here' });
      if (!selectedDestination?.[0]) return;
      if (selectedDestination[0].scheme !== 'file') throw new Error('Select a local destination.');
      destination = selectedDestination[0].fsPath;
    }
    const entries = importEntries(group, mode.original);
    ensureImportClean(destination, entries);
    const conflicts = await inspectImport(project.uri.fsPath, destination, entries);
    if (conflicts.length && await vscode.window.showWarningMessage(
      `Replace ${conflicts.length} existing file(s)?`,
      { modal: true, detail: conflicts.slice(0, 20).map(item => item.path).join('\n') }, 'Replace') !== 'Replace') return;
    ensureImportClean(destination, entries);
    const count = await writeImport(project.uri.fsPath, destination, entries, conflicts);
    void vscode.window.showInformationMessage(`Imported ${count} file(s) from "${group.name}".`);
  }

  /** @param {string} destination @param {import('./templates').Entry[]} entries */
  function ensureImportClean(destination, entries) {
    const targets = new Set(entries.filter(entry => entry.type === 'file').map(entry => path.resolve(destination, ...entry.path.split('/'))));
    if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
        targets.has(path.resolve(document.uri.fsPath)))) {
      throw new Error('Save or close unsaved destination files before importing.');
    }
  }
}

module.exports = { activate };
