const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function host(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vstemplater-command-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  const uri = filename => ({ scheme: 'file', fsPath: filename });
  const folder = { uri: uri(project), name: 'project', index: 0 };
  const commands = new Map();
  const messages = [];
  const errors = [];
  const picks = [];
  const inputs = [];
  const dialogs = [];
  const warnings = [];
  const opened = [];
  const workspacePicks = [];
  let workspacePickCount = 0;
  let tree;
  let files;
  class Disposable { dispose() {} }
  class EventEmitter {
    listeners = [];
    event = listener => { this.listeners.push(listener); return new Disposable(); };
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners = []; }
  }
  const vscode = {
    EventEmitter, Disposable,
    RelativePattern: class {},
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1 },
    FileType: { File: 1, Directory: 2 }, FileChangeType: { Changed: 1 },
    FileSystemError: Object.fromEntries(['FileNotFound', 'FileNotADirectory', 'FileIsADirectory', 'NoPermissions', 'FileExists'].map(code =>
      [code, message => Object.assign(new Error(String(message)), { code })])),
    Uri: { from: parts => ({ ...parts, toString() { return `${this.scheme}://${this.authority}${encodeURI(this.path)}`; } }) },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return new Disposable(); },
      executeCommand: async (id, uri) => { opened.push(uri); }
    },
    workspace: { workspaceFolders: [folder], isTrusted: true, textDocuments: [],
      createFileSystemWatcher: () => ({ dispose() {}, onDidChange: () => new Disposable(), onDidCreate: () => new Disposable(), onDidDelete: () => new Disposable() }),
      registerFileSystemProvider: (scheme, provider) => { files = provider; return new Disposable(); },
      getWorkspaceFolder: item => {
      return (vscode.workspace.workspaceFolders || []).filter(candidate => {
        const relative = path.relative(candidate.uri.fsPath, item.fsPath);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      }).sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
    } },
    window: {
      registerTreeDataProvider: (id, provider) => { tree = provider; return new Disposable(); },
      showErrorMessage: async message => { errors.push(message); },
      showInformationMessage: async message => { messages.push(message); },
      showWarningMessage: async () => warnings.shift(),
      showQuickPick: async items => {
        const label = picks.shift();
        return label === undefined ? undefined : items.find(item => item.label === label);
      },
      showInputBox: async () => inputs.shift(),
      showOpenDialog: async () => dialogs.shift(),
      showWorkspaceFolderPick: async () => { workspacePickCount++; return workspacePicks.length ? workspacePicks.shift() : folder; }
    }
  };
  function load(filename) {
    const localRequire = createRequire(filename);
    const sandbox = { Buffer, module: { exports: {} }, require: id =>
      id === 'vscode' ? vscode : id === './sync' ? { registerSync() {} } : id === './template-ui' ? load(localRequire.resolve(id)) : localRequire(id) };
    vm.runInNewContext(require('node:fs').readFileSync(filename, 'utf8'), sandbox, { filename });
    return sandbox.module.exports;
  }
  load(path.resolve(__dirname, '../src/extension.js')).activate({ globalStorageUri: uri(path.join(directory, 'storage')), subscriptions: [] });
  return { project, directory, uri, commands, messages, errors, picks, inputs, dialogs, warnings, vscode, tree, files, opened,
    workspacePicks, get workspacePickCount() { return workspacePickCount; } };
}

test('registered commands show the project-required error without opening pickers', async t => {
  const h = await host(t);
  h.vscode.workspace.workspaceFolders = undefined;
  await h.commands.get('vstemplater.add')();
  await h.commands.get('vstemplater.import')();
  assert.equal(h.errors.length, 2);
  assert.ok(h.errors.every(message => message === 'Open a project first.'));
});

test('command flow saves an existing group and imports beside a clicked file; cancellation preserves edits', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'hello');
  h.picks.push('$(add) Create new template group');
  h.inputs.push('Example');
  await h.commands.get('vstemplater.add')(h.uri(source));
  const second = path.join(h.project, 'second.txt');
  await fs.writeFile(second, 'second');
  h.picks.push('Example');
  await h.commands.get('vstemplater.add')(h.uri(second));
  const destination = path.join(h.project, 'destination');
  await fs.mkdir(destination);
  const clicked = path.join(destination, 'anchor.txt');
  await fs.writeFile(clicked, 'anchor');
  h.picks.push('Example', 'Keep original paths');
  await h.commands.get('vstemplater.import')(h.uri(clicked));
  assert.equal(await fs.readFile(path.join(destination, 'src/hello.txt'), 'utf8'), 'hello');
  assert.equal(await fs.readFile(path.join(destination, 'second.txt'), 'utf8'), 'second');
  await fs.writeFile(path.join(destination, 'src/hello.txt'), 'edited');
  h.picks.push('Example', 'Keep original paths');
  await h.commands.get('vstemplater.import')(h.uri(clicked));
  assert.equal(await fs.readFile(path.join(destination, 'src/hello.txt'), 'utf8'), 'edited');
  h.warnings.push('Replace');
  h.picks.push('Example', 'Keep original paths');
  await h.commands.get('vstemplater.import')(h.uri(clicked));
  assert.equal(await fs.readFile(path.join(destination, 'src/hello.txt'), 'utf8'), 'hello');
  assert.deepEqual(h.errors, []);
});

test('command palette supports a new path and cancellation without writing', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'hello');
  h.picks.push('$(add) Create new template group');
  h.inputs.push('Example');
  h.dialogs.push([h.uri(source)]);
  await h.commands.get('vstemplater.add')();
  const destination = path.join(h.project, 'custom');
  await fs.mkdir(destination);
  h.picks.push('Example', 'Choose a new path');
  h.dialogs.push(undefined);
  await h.commands.get('vstemplater.import')();
  assert.deepEqual(await fs.readdir(destination), []);
  h.picks.push('Example', 'Choose a new path');
  h.dialogs.push([h.uri(destination)]);
  await h.commands.get('vstemplater.import')();
  assert.equal(await fs.readFile(path.join(destination, 'hello.txt'), 'utf8'), 'hello');
  assert.deepEqual(h.errors, []);
});

test('add then import then add works while completion notifications remain open', { timeout: 2000 }, async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  const destination = path.join(h.project, 'destination');
  await fs.writeFile(source, 'hello');
  await fs.mkdir(destination);
  const notified = Promise.withResolvers();
  // VS Code resolves notification promises only when the user dismisses them.
  h.vscode.window.showInformationMessage = message => {
    h.messages.push(message);
    notified.resolve();
    return new Promise(() => {});
  };
  h.picks.push('$(add) Create new template group');
  h.inputs.push('Example');
  const adding = h.commands.get('vstemplater.add')(h.uri(source));
  await notified.promise;
  await new Promise(setImmediate);
  h.picks.push('Example', 'Keep original paths');
  const importing = h.commands.get('vstemplater.import')(h.uri(destination));
  await new Promise(setImmediate);
  assert.ok(!h.messages.includes('A template operation is already running.'), 'Import was blocked by the still-open save notification');
  await Promise.all([adding, importing]);
  assert.equal(await fs.readFile(path.join(destination, 'src/hello.txt'), 'utf8'), 'hello');
  h.picks.push('$(add) Create new template group');
  h.inputs.push('Another');
  await h.commands.get('vstemplater.add')(h.uri(source));
  assert.ok(!h.messages.includes('A template operation is already running.'), 'Add was blocked by the still-open import notification');
  assert.deepEqual(h.errors, []);
});

test('an open error notification does not block the next command', { timeout: 2000 }, async t => {
  const h = await host(t);
  const notified = Promise.withResolvers();
  h.vscode.window.showErrorMessage = message => {
    h.errors.push(message);
    notified.resolve();
    return new Promise(() => {});
  };
  h.picks.push('$(add) Create new template group');
  h.inputs.push('Example');
  const adding = h.commands.get('vstemplater.add')(h.uri(path.join(h.project, 'missing.txt')));
  await notified.promise;
  await new Promise(setImmediate);
  await h.commands.get('vstemplater.import')();
  assert.ok(!h.messages.includes('A template operation is already running.'));
  await adding;
  assert.ok(h.messages.includes('No templates yet. Use Add to Templates first.'));
  assert.equal(h.errors.length, 1);
});

test('tree shows groups, implicit parents and files; edit saves the template and selective import uses the saved edit', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'hello');
  h.picks.push('$(add) Create new template group');
  h.inputs.push('Example');
  let refreshed = 0;
  h.tree.onDidChangeTreeData(() => refreshed++);
  await h.commands.get('vstemplater.add')(h.uri(source));
  assert.ok(refreshed > 0);
  const [group] = await h.tree.getChildren();
  const [parent] = await h.tree.getChildren(group);
  const [file] = await h.tree.getChildren(parent);
  assert.equal(group.name, 'Example');
  assert.equal(parent.path, 'src');
  assert.equal(parent.type, 'directory');
  assert.equal(file.path, 'src/hello.txt');
  assert.equal(h.tree.getTreeItem(file).contextValue, 'templateFile');
  await h.commands.get('vstemplater.edit')(file);
  const uri = h.opened[0];
  assert.equal((await h.files.readFile(uri)).toString(), 'hello');
  assert.equal((await h.files.stat(uri)).size, 5);
  await h.files.writeFile(uri, Buffer.from('edited template'), { create: false, overwrite: true });
  assert.equal((await h.files.readFile(uri)).toString(), 'edited template');
  assert.equal(await fs.readFile(source, 'utf8'), 'hello');
  const [updatedGroup] = await h.tree.getChildren();
  const [updatedParent] = await h.tree.getChildren(updatedGroup);
  const [updatedFile] = await h.tree.getChildren(updatedParent);
  const destination = path.join(h.project, 'output');
  await fs.mkdir(destination);
  h.picks.push('Choose a new path');
  h.dialogs.push([h.uri(destination)]);
  await h.commands.get('vstemplater.importItem')(updatedFile);
  assert.deepEqual(await fs.readdir(destination), ['hello.txt']);
  assert.equal(await fs.readFile(path.join(destination, 'hello.txt'), 'utf8'), 'edited template');
  assert.deepEqual(h.errors, []);
});

test('management works without an open project; deletion requires confirmation and renames refresh the tree', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'hello');
  h.picks.push('$(add) Create new template group'); h.inputs.push('Example');
  await h.commands.get('vstemplater.add')(h.uri(source));
  h.vscode.workspace.workspaceFolders = undefined;
  let [group] = await h.tree.getChildren();
  h.inputs.push('Renamed');
  await h.commands.get('vstemplater.rename')(group);
  [group] = await h.tree.getChildren();
  assert.equal(group.name, 'Renamed');
  await h.commands.get('vstemplater.delete')(group);
  assert.equal((await h.tree.getChildren()).length, 1);
  const [parent] = await h.tree.getChildren(group);
  h.inputs.push('lib');
  await h.commands.get('vstemplater.rename')(parent);
  [group] = await h.tree.getChildren();
  const [renamedParent] = await h.tree.getChildren(group);
  assert.equal(renamedParent.path, 'lib');
  await h.commands.get('vstemplater.importItem')(group);
  assert.equal(h.errors.pop(), 'Open a project first.');
  h.warnings.push('Delete');
  await h.commands.get('vstemplater.delete')(group);
  assert.equal((await h.tree.getChildren()).length, 0);
  assert.equal(await fs.readFile(source, 'utf8'), 'hello');
  assert.deepEqual(h.errors, []);
});

test('dirty template editors block rename and deletion, and stale editor saves cannot overwrite newer content', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'hello');
  h.picks.push('$(add) Create new template group'); h.inputs.push('Example');
  await h.commands.get('vstemplater.add')(h.uri(source));
  const [group] = await h.tree.getChildren();
  const [parent] = await h.tree.getChildren(group);
  const [file] = await h.tree.getChildren(parent);
  await h.commands.get('vstemplater.edit')(file);
  const uri = h.opened[0];
  await h.files.readFile(uri);
  h.vscode.workspace.textDocuments.push({ uri, isDirty: true });
  await h.commands.get('vstemplater.delete')(group);
  await h.commands.get('vstemplater.rename')(parent);
  assert.equal(h.errors.length, 2);
  assert.ok(h.errors.every(message => message.includes('Save or close')));
  h.vscode.workspace.textDocuments = [];
  const { TemplateStore } = require('../src/templates');
  const store = new TemplateStore(path.join(h.directory, 'storage/templates'));
  await store.edit(await store.get('Example'), file.path, Buffer.from('newer'));
  await assert.rejects(h.files.writeFile(uri, Buffer.from('stale'), { create: false, overwrite: true }), /changed since it was opened/);
  assert.equal((await h.files.readFile(uri)).toString(), 'newer');
  await h.commands.get('vstemplater.delete')(group);
  assert.ok(h.errors.at(-1).includes('Refresh the Templates view'));
});

test('multi-root context commands use the clicked project; palette commands use the selected project and support cancellation', async t => {
  const h = await host(t);
  const otherProject = path.join(h.directory, 'other-project');
  await fs.mkdir(path.join(otherProject, 'src'), { recursive: true });
  const secondFolder = { uri: h.uri(otherProject), name: 'other', index: 1 };
  h.vscode.workspace.workspaceFolders.push(secondFolder);
  const source = path.join(otherProject, 'src/other.txt');
  await fs.writeFile(source, 'second project');
  h.picks.push('$(add) Create new template group'); h.inputs.push('Other');
  await h.commands.get('vstemplater.add')(h.uri(source));
  assert.equal(h.workspacePickCount, 0);
  const [group] = await h.tree.getChildren();
  const [parent] = await h.tree.getChildren(group);
  const [file] = await h.tree.getChildren(parent);
  assert.equal(file.path, 'src/other.txt');
  h.workspacePicks.push(h.vscode.workspace.workspaceFolders[0]);
  h.picks.push('Other', 'Keep original paths'); h.dialogs.push([h.uri(h.project)]);
  await h.commands.get('vstemplater.import')();
  assert.equal(h.workspacePickCount, 1);
  assert.equal(await fs.readFile(path.join(h.project, 'src/other.txt'), 'utf8'), 'second project');
  const before = h.messages.length;
  h.workspacePicks.push(undefined);
  await h.commands.get('vstemplater.import')();
  assert.equal(h.workspacePickCount, 2);
  assert.equal(h.messages.length, before);
  h.workspacePicks.push(secondFolder);
  h.picks.push('Other', 'Choose a new path'); h.dialogs.push([h.uri(h.project)]);
  await h.commands.get('vstemplater.import')();
  assert.ok(h.errors.pop().includes('inside the project'));
  assert.deepEqual(h.errors, []);
});

test('dirty destination files block import before the prompt and are rechecked after confirmation', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'template');
  h.picks.push('$(add) Create new template group'); h.inputs.push('Example');
  await h.commands.get('vstemplater.add')(h.uri(source));
  const destination = path.join(h.project, 'output');
  await fs.mkdir(path.join(destination, 'src'), { recursive: true });
  const target = path.join(destination, 'src/hello.txt');
  await fs.writeFile(target, 'keep destination');
  const dirty = { uri: h.uri(target), isDirty: true };
  h.vscode.workspace.textDocuments.push(dirty);
  h.warnings.push('Replace');
  h.picks.push('Example', 'Keep original paths');
  await h.commands.get('vstemplater.import')(h.uri(destination));
  assert.ok(h.errors.pop().includes('unsaved destination files'));
  assert.equal(h.warnings.length, 1);
  h.vscode.workspace.textDocuments = [];
  h.vscode.window.showWarningMessage = async () => { h.vscode.workspace.textDocuments.push(dirty); return 'Replace'; };
  h.picks.push('Example', 'Keep original paths');
  await h.commands.get('vstemplater.import')(h.uri(destination));
  assert.ok(h.errors.pop().includes('unsaved destination files'));
  assert.equal(await fs.readFile(target, 'utf8'), 'keep destination');
  assert.deepEqual(h.errors, []);
});

test('a destination changed during the confirmation prompt is not overwritten', async t => {
  const h = await host(t);
  const source = path.join(h.project, 'src/hello.txt');
  await fs.writeFile(source, 'template');
  h.picks.push('$(add) Create new template group'); h.inputs.push('Example');
  await h.commands.get('vstemplater.add')(h.uri(source));
  let detail;
  h.vscode.window.showWarningMessage = async (message, options) => {
    detail = options.detail;
    await fs.writeFile(source, 'edited while confirmation was open');
    return 'Replace';
  };
  h.picks.push('Example', 'Keep original paths');
  await h.commands.get('vstemplater.import')(h.uri(h.project));
  assert.equal(detail, 'src/hello.txt');
  assert.ok(h.errors.pop().includes('destination changed'));
  assert.equal(await fs.readFile(source, 'utf8'), 'edited while confirmation was open');
});
