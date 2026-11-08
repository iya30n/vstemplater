const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');
const { TemplateStore, importEntries, inspectImport, writeImport } = require('../../src/templates');
const { templateUri } = require('../../src/template-ui');

async function run() {
  if (!process.env.VSTEMPLATER_TEST_ROOT) throw new Error('Run this test with an isolated VS Code user-data directory.');
  const storage = path.join(process.env.VSTEMPLATER_TEST_ROOT, 'user/User/globalStorage/vstemplater-local.vstemplater/templates');
  const store = new TemplateStore(storage);
  await store.save('Editor Smoke', { roots: ['src/hello.txt'], entries: [
    { path: 'src/hello.txt', type: 'file', content: Buffer.from('hello').toString('base64'), mode: 0o644 }
  ] }, undefined);
  const extension = vscode.extensions.getExtension('vstemplater-local.vstemplater');
  assert.ok(extension, 'Development extension is registered');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['add', 'import', 'importItem', 'edit', 'rename', 'delete', 'refresh']) {
    assert.ok(commands.includes(`vstemplater.${id}`), `Command ${id} is registered`);
  }
  await vscode.commands.executeCommand('vstemplater.templates.focus');
  const uri = templateUri('Editor Smoke', 'src/hello.txt');
  const document = await vscode.workspace.openTextDocument(uri);
  assert.equal(document.getText(), 'hello');
  await vscode.window.showTextDocument(document);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'saved from VS Code');
  assert.ok(await vscode.workspace.applyEdit(edit));
  assert.ok(await document.save(), 'The virtual template document saves through VS Code');
  const saved = await store.get('Editor Smoke');
  assert.equal(Buffer.from(saved.entries[0].content, 'base64').toString(), 'saved from VS Code');
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString(), 'saved from VS Code');
  const project = vscode.workspace.workspaceFolders[0].uri;
  const entries = importEntries(saved, true);
  assert.equal(await writeImport(project.fsPath, project.fsPath, entries, []), 1);
  const conflicts = await inspectImport(project.fsPath, project.fsPath, entries);
  assert.equal(conflicts.length, 1);
  assert.equal(typeof conflicts[0].stamp, 'string');
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(project, 'src/hello.txt'))).toString(), 'saved from VS Code');
  console.log('VSTEMPLATER_HOST_SMOKE_PASS: activation, Templates view, virtual editor, Save and local import');
}

module.exports = { run };
