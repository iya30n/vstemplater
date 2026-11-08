const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { blobSha, groupId, MANIFEST, LEGACY } = require('../src/github-storage');
const { TemplateStore } = require('../src/templates');

async function device(t, remote) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vstemplater-sync-'));
  const store = new TemplateStore(root);
  const commands = new Map(), state = new Map(), errors = [], choices = [];
  const subscriptions = [];
  class Disposable { constructor(fn = () => {}) { this.fn = fn; } dispose() { this.fn(); } }
  const vscode = {
    Disposable, RelativePattern: class {}, StatusBarAlignment: { Left: 1 },
    authentication: { getSession: async () => ({ accessToken: 'test', account: { id: 'test' } }) },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return new Disposable(); } },
    workspace: { textDocuments: [], createFileSystemWatcher: () => ({ dispose() {}, onDidCreate: () => new Disposable(), onDidChange: () => new Disposable(), onDidDelete: () => new Disposable() }) },
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }), showInformationMessage() {},
      showErrorMessage: msg => errors.push(msg), showQuickPick: async () => choices.shift() }
  };
  let automatic;
  const sandbox = { module: { exports: {} }, Buffer, AbortSignal, setInterval: (fn, ms) => { automatic = fn; return setInterval(fn, ms); }, clearInterval, setTimeout, clearTimeout,
    fetch: remote.fetch, require: id => id === 'vscode' ? vscode : id === './github-storage' ? require('../src/github-storage') : require(id) };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/sync.js'), 'utf8'), sandbox);
  sandbox.module.exports.registerSync({ globalStorageUri: {}, subscriptions, globalState: {
    get: key => state.get(key), update: async (key, value) => state.set(key, value)
  } }, store, () => {});
  state.set('githubSync', { repo: 'owner/private', branch: 'main', account: 'test', base: {} });
  t.after(async () => { subscriptions.forEach(item => item.dispose()); await fs.rm(root, { recursive: true, force: true }); });
  const put = async (name, content) => store.save(name, { roots: ['file.txt'], entries: [{ path: 'file.txt', type: 'file', mode: 420, content: Buffer.from(content).toString('base64') }] }, (await store.get(name))?.revision);
  return { store, errors, choices, put, sync: commands.get('vstemplater.sync'), vscode, state, automatic: () => automatic() };
}

test('two devices upload, download, edit and propagate deletions', async t => {
  const remote = repository(); const a = await device(t, remote), b = await device(t, remote);
  await a.put('UI', 'one'); await a.sync(); await b.sync();
  assert.equal((await b.store.get('UI')).entries[0].content, Buffer.from('one').toString('base64'));
  await b.put('UI', 'two'); await b.sync(); await a.sync();
  assert.equal((await a.store.get('UI')).entries[0].content, Buffer.from('two').toString('base64'));
  await a.store.remove(await a.store.get('UI'), ''); a.choices.push('Delete all synced templates'); await a.sync(); b.choices.push('Delete all synced templates'); await b.sync();
  assert.equal(await b.store.get('UI'), undefined);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('conflict cancellation preserves both versions; explicit local selection resolves it', async t => {
  const remote = repository(); const a = await device(t, remote), b = await device(t, remote);
  await a.put('UI', 'base'); await a.sync(); await b.sync();
  await a.put('UI', 'remote'); await a.sync(); await b.put('UI', 'local');
  const before = remote.head; await b.sync(); assert.equal(remote.head, before);
  assert.match(b.errors.pop(), /cancelled/);
  b.choices.push('Keep local group'); await b.sync(); await a.sync();
  assert.equal((await a.store.get('UI')).entries[0].content, Buffer.from('local').toString('base64'));
});

test('offline changes survive and retry; a rejected remote write cannot apply downloaded changes', async t => {
  const remote = repository(); const a = await device(t, remote), b = await device(t, remote);
  await a.put('A', 'one'); remote.offline = true; await a.sync();
  assert.ok(await a.store.get('A')); remote.offline = false; await a.sync(); await b.sync();
  await a.put('A', 'new'); await a.sync(); await b.put('B', 'local');
  remote.reject = true; await b.sync();
  assert.match(b.errors.pop(), /409/);
  assert.equal((await b.store.get('A')).entries[0].content, Buffer.from('one').toString('base64'));
  assert.ok(await b.store.get('B'));
});

test('invalid remote paths and dirty editors prevent local replacement', async t => {
  const remote = repository(); const a = await device(t, remote);
  await a.put('UI', 'local'); await a.sync();
  const malformed = JSON.parse(remote.read(MANIFEST)); malformed.groups[0].entries[0].path = '../escape'; remote.seed(MANIFEST, JSON.stringify(malformed));
  await a.sync(); assert.match(a.errors.pop(), /Invalid template path/);
  assert.ok(await a.store.get('UI'));
  a.vscode.workspace.textDocuments.push({ isDirty: true, uri: { scheme: 'vstemplater' } });
  await a.sync(); assert.match(a.errors.pop(), /unsaved/);
});

// In-memory Git object server: objects are immutable, and only a fast-forward ref publishes them.
function repository() {
  const blobs = new Map(), trees = new Map(), commits = new Map();
  let serial = 0;
  const remote = { head: '', uploads: 0, writes: 0,
    files() { return trees.get(commits.get(this.head).tree.sha); },
    read(name) { return blobs.get(this.files().get(name)?.sha); },
    seed(name, content) {
      const files = this.head ? new Map(this.files()) : new Map();
      if (content === null) files.delete(name);
      else { const bytes = Buffer.from(content), sha = blobSha(bytes); blobs.set(sha, bytes); files.set(name, { path: name, type: 'blob', mode: '100644', sha }); }
      const tree = `tree${++serial}`; trees.set(tree, files);
      const head = `commit${++serial}`; commits.set(head, { tree: { sha: tree }, parents: [this.head] }); this.head = head;
    },
    async fetch(url, options) {
      if (remote.offline) throw new Error('Offline');
      const route = url.split('/git/')[1], body = options.body && JSON.parse(options.body);
      let result, status = 200;
      if (!route) result = { private: true };
      else if (remote.fail === route) status = 500;
      else if (options.method === 'GET') {
        if (route.startsWith('ref/')) result = { object: { sha: remote.head } };
        else if (route.startsWith('commits/')) result = commits.get(route.slice(8));
        else if (route.startsWith('trees/')) {
          const files = trees.get(route.slice(6).split('?')[0]);
          const entries = new Map(files);
          for (const name of files.keys()) {
            const parts = name.split('/'); parts.pop();
            while (parts.length) { const path = parts.join('/'); entries.set(path, { path, mode: '040000', type: 'tree', sha: 'directory' }); parts.pop(); }
          }
          result = { tree: [...entries.values()], truncated: !!remote.truncated };
        } else if (route.startsWith('blobs/')) result = { encoding: 'base64', content: blobs.get(route.slice(6)).toString('base64') };
      } else if (route === 'blobs') {
        const bytes = Buffer.from(body.content, body.encoding), sha = blobSha(bytes);
        blobs.set(sha, bytes); remote.uploads++; result = { sha };
      } else if (route === 'trees') {
        const files = new Map(trees.get(body.base_tree));
        for (const item of body.tree) { if (item.sha === null) files.delete(item.path); else files.set(item.path, item); }
        const sha = `tree${++serial}`; trees.set(sha, files); result = { sha };
      } else if (route === 'commits') {
        const sha = `commit${++serial}`; commits.set(sha, { tree: { sha: body.tree }, parents: body.parents }); result = { sha };
      } else if (route.startsWith('refs/')) {
        assert.equal(body.force, false);
        if (remote.race) { remote.seed('external.txt', 'concurrent edit'); remote.race = false; }
        if (remote.reject || !commits.get(body.sha).parents.includes(remote.head)) status = 409;
        else { remote.head = body.sha; remote.writes++; result = {}; }
      }
      if (status === 200) assert.notEqual(result, undefined, `Unhandled request ${options.method} ${route}`);
      return { ok: status === 200, status, json: async () => result };
    }
  };
  remote.seed('README.md', 'unrelated');
  return remote;
}

test('real files round-trip binary, executable and empty directories without collection size cap', async t => {
  const remote = repository(), a = await device(t, remote), b = await device(t, remote);
  const bytes = Buffer.alloc(800000, 255);
  await a.store.save('Large', { roots: ['src'], entries: [
    { path: 'src', type: 'directory' }, { path: 'src/empty', type: 'directory' },
    { path: 'src/run.bin', type: 'file', content: bytes.toString('base64'), mode: 493 }
  ] });
  await a.sync(); await b.sync();
  assert.deepEqual(remote.read(`templates/${groupId('Large')}/src/run.bin`), bytes);
  assert.equal(remote.files().get(`templates/${groupId('Large')}/src/run.bin`).mode, '100755');
  assert.equal(remote.read('README.md').toString(), 'unrelated');
  assert.ok(!remote.read(MANIFEST).toString().includes('content'));
  assert.deepEqual((await b.store.get('Large')).entries, (await a.store.get('Large')).entries);
  const writes = remote.writes, uploads = remote.uploads;
  await a.sync(); await b.sync(); assert.equal(remote.writes, writes); assert.equal(remote.uploads, uploads);
  assert.deepEqual([...a.errors, ...b.errors], []);
});

test('content-only updates upload one blob and accept edits made in GitHub', async t => {
  const remote = repository(), a = await device(t, remote);
  await a.put('UI', 'first'); await a.sync();
  const uploads = remote.uploads; await a.put('UI', 'second'); await a.sync();
  assert.equal(remote.uploads - uploads, 1);
  remote.seed(`templates/${groupId('UI')}/file.txt`, 'GitHub edit'); await a.sync();
  assert.equal(Buffer.from((await a.store.get('UI')).entries[0].content, 'base64').toString(), 'GitHub edit');
  assert.deepEqual(a.errors, []);
});

test('legacy migration is atomic and failed writes keep legacy and local data intact', async t => {
  for (const fail of ['blobs', 'trees', 'commits', 'refs/heads/main', undefined]) {
    const remote = repository(), a = await device(t, remote);
    await a.put('Old', 'legacy bytes'); const group = await a.store.get('Old');
    remote.seed(LEGACY, JSON.stringify({ version: 1, groups: [group] }));
    await a.store.remove(group, '');
    const before = remote.head; remote.fail = fail; await a.sync();
    if (fail) {
      assert.equal(remote.head, before); assert.ok(remote.read(LEGACY)); assert.equal(await a.store.get('Old'), undefined);
      remote.fail = undefined; await a.sync();
    }
    assert.equal(remote.read(LEGACY), undefined);
    assert.equal(remote.read(`templates/${groupId('Old')}/file.txt`).toString(), 'legacy bytes');
    assert.ok(await a.store.get('Old')); assert.equal(remote.read('README.md').toString(), 'unrelated');
  }
});

test('concurrent branch updates reject publishing and preserve the sync baseline', async t => {
  const remote = repository(), a = await device(t, remote);
  await a.put('UI', 'base'); await a.sync();
  const base = a.state.get('githubSync'); await a.put('UI', 'new'); remote.race = true; await a.sync();
  assert.match(a.errors.pop(), /409/); assert.equal(a.state.get('githubSync'), base);
  assert.equal(remote.read('external.txt').toString(), 'concurrent edit');
  assert.equal(remote.read(`templates/${groupId('UI')}/file.txt`).toString(), 'base');
  await a.sync(); assert.equal(remote.read(`templates/${groupId('UI')}/file.txt`).toString(), 'new');
});

test('missing tracked files, incomplete trees and legacy reappearance stop sync', async t => {
  for (const problem of ['missing', 'truncated', 'legacy']) {
    const remote = repository(), a = await device(t, remote);
    await a.put('UI', 'base'); await a.sync();
    if (problem === 'missing') remote.seed(`templates/${groupId('UI')}/file.txt`, null);
    if (problem === 'truncated') remote.truncated = true;
    if (problem === 'legacy') remote.seed(LEGACY, '{}');
    const before = remote.head; await a.sync();
    assert.equal(remote.head, before); assert.equal(a.errors.length, 1); assert.ok(await a.store.get('UI'));
  }
});

test('untracked paths cannot be overwritten and group deletion preserves unrelated files', async t => {
  const remote = repository(), a = await device(t, remote);
  const filename = `templates/${groupId('UI')}/file.txt`;
  remote.seed(MANIFEST, JSON.stringify({ version: 2, groups: [] }));
  remote.seed(filename, 'untracked'); await a.put('UI', 'local'); await a.sync();
  assert.match(a.errors.pop(), /Untracked/); assert.equal(remote.read(filename).toString(), 'untracked');
  remote.seed(filename, null); await a.sync();
  remote.seed(`templates/${groupId('UI')}/other.txt`, 'unrelated');
  await a.store.remove(await a.store.get('UI'), ''); a.choices.push('Delete all synced templates'); await a.sync();
  assert.equal(remote.read(filename), undefined);
  assert.equal(remote.read(`templates/${groupId('UI')}/other.txt`).toString(), 'unrelated');
});

test('missing remote manifest must not erase previously synced local templates', async t => {
  const remote = repository(), a = await device(t, remote);
  await a.put('UI', 'keep me'); await a.sync();
  remote.seed(MANIFEST, null);
  const head = remote.head;
  await a.sync();
  assert.ok(await a.store.get('UI'), 'sync must preserve local groups when the remote index disappears');
  assert.equal(remote.head, head);
  assert.match(a.errors.pop(), /manifest|metadata/i);
});

test('an empty local store cannot silently delete the entire GitHub collection', async t => {
  const remote = repository(), a = await device(t, remote);
  await a.put('UI', 'recoverable'); await a.sync();
  await a.store.remove(await a.store.get('UI'), '');
  const head = remote.head, base = a.state.get('githubSync');
  await a.sync();
  assert.equal(remote.head, head, 'cancelling collection deletion must preserve GitHub');
  assert.equal(a.state.get('githubSync'), base);
  assert.match(a.errors.pop(), /cancelled/i);
  a.choices.push('Delete all synced templates'); await a.sync();
  assert.equal(JSON.parse(remote.read(MANIFEST)).groups.length, 0);
});

test('an empty remote manifest cannot silently erase all local groups', async t => {
  const remote = repository(), a = await device(t, remote);
  await a.put('UI', 'recoverable'); await a.sync();
  remote.seed(MANIFEST, JSON.stringify({ version: 2, groups: [] }));
  remote.seed(`templates/${groupId('UI')}/file.txt`, null);
  await a.sync();
  assert.ok(await a.store.get('UI'), 'cancelled deletion must preserve local files');
  assert.match(a.errors.pop(), /cancelled/i);
});


test('automatic all-group deletion pauses; keeping remaining templates restores the empty side', async t => {
  const remote = repository(), a = await device(t, remote);
  await a.put('UI', 'keep'); await a.sync();
  await a.store.remove(await a.store.get('UI'), '');
  const head = remote.head;
  a.automatic();
  // Wait for the async automatic pass to finish without driving the manual command.
  for (let n = 0; n < 30; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(remote.head, head);
  a.choices.push('Keep remaining templates'); await a.sync();
  assert.ok(await a.store.get('UI')); assert.equal(remote.head, head);
  assert.deepEqual(a.errors, []);
});
