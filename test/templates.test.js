const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { TemplateStore, collect, importEntries, inspectImport, writeImport, validatePath, selectItem } = require('../src/templates');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vstemplater-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await fs.mkdir(path.join(project, 'src', 'Button', 'empty'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'Button', 'index.js'), 'original');
  await fs.writeFile(path.join(project, 'src', 'Button', 'image.bin'), Buffer.from([0, 255, 128, 1]));
  return { directory, project, source: path.join(project, 'src', 'Button'), store: new TemplateStore(path.join(directory, 'storage')) };
}

test('persist a group across store instances; preserve paths, bytes and empty folders without a group wrapper', async t => {
  const { project, source, store } = await fixture(t);
  const addition = await collect(project, source);
  await store.save('UI فارسی', addition, undefined);
  const reopened = new TemplateStore(store.directory);
  const group = await reopened.get('UI فارسی');
  assert.deepEqual(group.roots, ['src/Button']);
  const destination = path.join(project, 'output');
  await fs.mkdir(destination);
  await writeImport(project, destination, importEntries(group, true), []);
  assert.equal(await fs.readFile(path.join(destination, 'src/Button/index.js'), 'utf8'), 'original');
  assert.deepEqual(await fs.readFile(path.join(destination, 'src/Button/image.bin')), Buffer.from([0, 255, 128, 1]));
  assert.ok((await fs.stat(path.join(destination, 'src/Button/empty'))).isDirectory());
  assert.deepEqual(await fs.readdir(destination), ['src']);
  await fs.writeFile(path.join(source, 'index.js'), 'changed source');
  assert.equal(Buffer.from((await reopened.get('UI فارسی')).entries.find(e => e.path.endsWith('index.js')).content, 'base64').toString(), 'original');
});

test('new destination strips a single root parent but keeps the selected folder', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  const entries = importEntries(await store.get('UI'), false);
  assert.ok(entries.some(e => e.path === 'Button/index.js'));
  const destination = path.join(project, 'custom');
  await fs.mkdir(destination);
  await writeImport(project, destination, entries, []);
  assert.equal(await fs.readFile(path.join(destination, 'Button/index.js'), 'utf8'), 'original');
});

test('adding to an existing group merges files and rejects stale updates', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, path.join(source, 'index.js')), undefined);
  const previous = await store.get('UI');
  await store.save('UI', await collect(project, source), previous.revision);
  const merged = await store.get('UI');
  assert.deepEqual(merged.roots, ['src/Button']);
  assert.equal(merged.entries.filter(e => e.path.endsWith('index.js')).length, 1);
  await assert.rejects(store.save('UI', await collect(project, source), previous.revision), /another window/);
  assert.equal((await store.get('UI')).revision, merged.revision);
});

test('excluded paths are omitted, while .env.example is retained', async t => {
  const { project, source } = await fixture(t);
  for (const filename of ['.env', '.env.local', '.env.example']) await fs.writeFile(path.join(source, filename), 'value');
  for (const directory of ['node_modules', '.git']) {
    await fs.mkdir(path.join(source, directory));
    await fs.writeFile(path.join(source, directory, 'secret'), 'secret');
  }
  const result = await collect(project, source);
  assert.equal(result.skipped.length, 4);
  assert.ok(result.entries.some(e => e.path.endsWith('/.env.example')));
  assert.ok(!result.entries.some(e => e.path.endsWith('/secret') || e.path.endsWith('/.env')));
  await assert.rejects(collect(project, path.join(source, '.env')), /excluded/);
});

test('overwrite requires approval and a newly appeared conflict prevents all writes', async t => {
  const { project, source } = await fixture(t);
  const { entries } = await collect(project, source);
  const conflicts = await inspectImport(project, project, entries);
  assert.equal(conflicts.length, 2);
  await assert.rejects(writeImport(project, project, entries, []), /confirm replacements/);
  await fs.writeFile(path.join(source, 'index.js'), 'edited');
  await writeImport(project, project, entries, await inspectImport(project, project, entries));
  assert.equal(await fs.readFile(path.join(source, 'index.js'), 'utf8'), 'original');
  const destination = path.join(project, 'other');
  await fs.mkdir(path.join(destination, 'src/Button'), { recursive: true });
  await fs.writeFile(path.join(destination, 'src/Button/index.js'), 'keep me');
  await assert.rejects(writeImport(project, destination, entries, []), /confirm replacements/);
  assert.equal(await fs.readFile(path.join(destination, 'src/Button/index.js'), 'utf8'), 'keep me');
  await assert.rejects(fs.stat(path.join(destination, 'src/Button/image.bin')), { code: 'ENOENT' });
});

test('type conflicts and symbolic links fail before copying; destinations cannot escape the project', async t => {
  const { project, source, directory } = await fixture(t);
  const { entries } = await collect(project, source);
  const destination = path.join(project, 'other');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'src'), 'blocker');
  await assert.rejects(inspectImport(project, destination, entries), /ENOTDIR|type conflict/);
  await assert.rejects(inspectImport(project, directory, entries), /inside the project/);
  await fs.symlink(source, path.join(project, 'linked'), 'dir');
  await assert.rejects(collect(project, path.join(project, 'linked/index.js')), /Symbolic links/);
  await assert.rejects(inspectImport(project, path.join(project, 'linked'), entries), /Symbolic links/);
  await fs.symlink(path.join(source, 'index.js'), path.join(source, 'alias'));
  await assert.rejects(collect(project, source), /Symbolic links/);
});

test('portable paths reject traversal and Windows special paths', () => {
  for (const value of ['../secret', '/absolute', 'a/../../b', 'a\\b', 'C:/secret', 'a//b', 'NUL.txt', 'dir/name.', 'dir/name ', 'x\0y']) {
    assert.throws(() => validatePath(value), /Invalid template path/);
  }
  validatePath('src/فارسی/index.js');
});

test('corrupt stored paths are rejected rather than written outside the destination', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  const group = await store.get('UI');
  group.entries[0].path = '../escape';
  await fs.writeFile(store.filename('UI'), JSON.stringify(group));
  await assert.rejects(store.get('UI'), /Invalid template path/);
});

test('multiple roots preserve their relative structure at a new destination', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  await fs.writeFile(path.join(project, 'README.md'), 'readme');
  await store.save('UI', await collect(project, path.join(project, 'README.md')), (await store.get('UI')).revision);
  const entries = importEntries(await store.get('UI'), false);
  assert.ok(entries.some(e => e.path === 'src/Button/index.js'));
  assert.ok(entries.some(e => e.path === 'README.md'));
});

test('rename preserves bytes and updates saved roots, including implicit parent folders', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  let group = await store.rename(await store.get('UI'), 'src', 'lib');
  assert.deepEqual(group.roots, ['lib/Button']);
  assert.ok(group.entries.some(entry => entry.path === 'lib/Button/index.js'));
  group = await store.rename(group, 'lib/Button/image.bin', 'icon.bin');
  group = await store.rename(group, '', 'Renamed فارسی');
  assert.equal(await store.get('UI'), undefined);
  assert.equal((await store.list())[0].name, 'Renamed فارسی');
  assert.deepEqual(Buffer.from(group.entries.find(entry => entry.path === 'lib/Button/icon.bin').content, 'base64'), Buffer.from([0, 255, 128, 1]));
  assert.equal(await fs.readFile(path.join(source, 'index.js'), 'utf8'), 'original');
});

test('rename rejects occupied names and stale revisions without changing saved data', async t => {
  const { project, source, store } = await fixture(t);
  const addition = await collect(project, source);
  await store.save('UI', addition, undefined);
  await store.save('Other', addition, undefined);
  const group = await store.get('UI');
  await assert.rejects(store.rename(group, '', 'Other'), /already exists/);
  await assert.rejects(store.rename(group, 'src/Button/index.js', 'image.bin'), /already exists/);
  await assert.rejects(store.rename(group, 'src/Button', '../escape'), /Invalid template path/);
  await assert.rejects(store.rename(group, 'src/Button', 'a/b'), /not a path/);
  assert.equal((await store.get('UI')).revision, group.revision);
  await store.edit(group, 'src/Button/index.js', Buffer.from('updated'));
  await assert.rejects(store.remove(group, 'src'), /another window/);
  assert.ok((await store.get('UI')).entries.length);
});

test('delete file, empty folder, implicit parent, and entire group without touching source files', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  let group = await store.remove(await store.get('UI'), 'src/Button/index.js');
  assert.ok(!group.entries.some(entry => entry.path.endsWith('index.js')));
  group = await store.remove(group, 'src/Button/empty');
  assert.ok(!group.entries.some(entry => entry.path.endsWith('/empty')));
  group = await store.remove(group, 'src');
  assert.deepEqual(group.entries, []);
  assert.deepEqual(group.roots, []);
  assert.deepEqual((await store.get('UI')).entries, []);
  await store.remove(group, '');
  assert.deepEqual(await store.list(), []);
  assert.equal(await fs.readFile(path.join(source, 'index.js'), 'utf8'), 'original');
});

test('editing content preserves modes and other files; stale edits cannot overwrite a newer version', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  const original = await store.get('UI');
  const edited = await store.edit(original, 'src/Button/index.js', Buffer.from('new content'));
  const entry = edited.entries.find(entry => entry.path.endsWith('index.js'));
  assert.equal(Buffer.from(entry.content, 'base64').toString(), 'new content');
  assert.equal(entry.mode, original.entries.find(item => item.path === entry.path).mode);
  assert.deepEqual(edited.entries.find(item => item.path.endsWith('image.bin')), original.entries.find(item => item.path.endsWith('image.bin')));
  await assert.rejects(store.edit(original, entry.path, Buffer.from('stale')), /another window/);
  assert.equal(await fs.readFile(path.join(source, 'index.js'), 'utf8'), 'original');
});

test('selected files and virtual folders import independently with original or rebased paths', async t => {
  const { project, source, store } = await fixture(t);
  await store.save('UI', await collect(project, source), undefined);
  const group = await store.get('UI');
  const file = selectItem(group, 'src/Button/index.js');
  assert.deepEqual(importEntries(file, true).map(entry => entry.path), ['src/Button/index.js']);
  assert.deepEqual(importEntries(file, false).map(entry => entry.path), ['index.js']);
  const folder = selectItem(group, 'src');
  assert.deepEqual(folder.roots, ['src']);
  assert.ok(folder.entries.some(entry => entry.path === 'src' && entry.type === 'directory'));
  assert.equal(folder.entries.length, group.entries.length + 1);
  await assert.rejects(async () => selectItem(group, 'missing'), /no longer exists/);
});

test('a destination edited while replacement confirmation is open is preserved', async t => {
  const { project, source } = await fixture(t);
  const { entries } = await collect(project, source);
  const approved = await inspectImport(project, project, entries);
  await fs.writeFile(path.join(source, 'index.js'), 'new edits after the prompt opened');
  await assert.rejects(writeImport(project, project, entries, approved), /destination changed/i);
  assert.equal(await fs.readFile(path.join(source, 'index.js'), 'utf8'), 'new edits after the prompt opened');
});

test('case and Unicode aliases, including implicit parents, fail before any import writes', async t => {
  const { project, store } = await fixture(t);
  const file = name => ({ path: name, type: 'file', mode: 0o644, content: Buffer.from(name).toString('base64') });
  for (const names of [['A.txt', 'a.txt'], ['src/a.txt', 'SRC/b.txt'], ['café.txt', 'cafe\u0301.txt']]) {
    const entries = names.map(file);
    const addition = { roots: names, entries };
    await assert.rejects(store.save('Aliases', addition, undefined), /Conflicting template paths/);
    const destination = path.join(project, `output-${names[0].length}`);
    await fs.mkdir(destination, { recursive: true });
    await assert.rejects(writeImport(project, destination, entries, []), /Conflicting template paths/);
    assert.deepEqual(await fs.readdir(destination), []);
  }
});

test('exclusion names are matched regardless of case while env examples remain eligible', async t => {
  const { project, source } = await fixture(t);
  await fs.writeFile(path.join(source, '.ENV.PRODUCTION'), 'secret');
  await fs.writeFile(path.join(source, '.ENV.EXAMPLE'), 'example');
  const result = await collect(project, source);
  assert.ok(!result.entries.some(entry => entry.path.endsWith('.ENV.PRODUCTION')));
  assert.ok(result.entries.some(entry => entry.path.endsWith('.ENV.EXAMPLE')));
});

test('filesystem failure reports partial import, cleans temporary files and allows retry', async t => {
  const { project, source } = await fixture(t);
  const { entries } = await collect(project, source);
  const destination = path.join(project, 'output');
  await fs.mkdir(destination);
  const originalLink = fs.link;
  let writes = 0;
  fs.link = async (...args) => {
    if (++writes === 2) throw Object.assign(new Error('simulated permission denied'), { code: 'EACCES' });
    return originalLink(...args);
  };
  try {
    await assert.rejects(writeImport(project, destination, entries, []), /stopped after 1 file\(s\).*permission denied/);
  } finally { fs.link = originalLink; }
  const contents = await fs.readdir(destination, { recursive: true });
  assert.ok(!contents.some(name => name.includes('.vstemplater-')));
  assert.deepEqual(await fs.readFile(path.join(destination, 'src/Button/image.bin')), Buffer.from([0, 255, 128, 1]));
  await writeImport(project, destination, entries, await inspectImport(project, destination, entries));
  assert.equal(await fs.readFile(path.join(destination, 'src/Button/index.js'), 'utf8'), 'original');
});
