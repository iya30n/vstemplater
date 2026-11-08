const { createHash } = require('node:crypto');
const { validateGroup, validatePaths } = require('./templates');

const MANIFEST = '.vstemplater/manifest.json';
const LEGACY = '.vstemplater.json';
/** @typedef {import('./templates').Group} Group */
/** @typedef {{path: string, type: string, mode: string, sha: string}} GitEntry */
/** @typedef {{head: string, treeSha: string, tree: Map<string, GitEntry>, groups: Map<string, Group>, tracked: Set<string>, legacy: boolean}} Snapshot */

/** @param {Uint8Array} bytes */
function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** @param {string} name */
function groupId(name) { return createHash('sha256').update(name).digest('hex'); }

class GitHubStorage {
  /** @param {(route: string, method?: string, body?: unknown) => Promise<any>} request
   * @param {string} repo @param {string} branch @param {Iterable<Group>} local
   */
  constructor(request, repo, branch, local) {
    this.request = request;
    this.route = `/repos/${repo}/git`;
    this.branch = branch.split('/').map(encodeURIComponent).join('/');
    /** @type {Map<string, Buffer>} */
    this.blobs = new Map();
    for (const group of local) for (const entry of group.entries) {
      if (entry.type === 'file') {
        const bytes = Buffer.from(entry.content || '', 'base64');
        this.blobs.set(blobSha(bytes), bytes);
      }
    }
  }

  /** @param {GitEntry | undefined} entry */
  async readBlob(entry) {
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new Error('A tracked template file is missing or is not a regular file. Restore it or update the manifest.');
    }
    let bytes = this.blobs.get(entry.sha);
    if (!bytes) {
      const blob = await this.request(`${this.route}/blobs/${entry.sha}`);
      if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('Invalid GitHub blob response.');
      bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
      if (blobSha(bytes) !== entry.sha) throw new Error('GitHub file checksum mismatch. Sync stopped.');
      this.blobs.set(entry.sha, bytes);
    }
    return bytes;
  }

  /** @returns {Promise<Snapshot>} */
  async read() {
    const ref = await this.request(`${this.route}/ref/heads/${this.branch}`);
    if (!ref?.object?.sha) throw new Error('The sync branch is missing. Reconnect the repository.');
    const head = ref.object.sha;
    const commit = await this.request(`${this.route}/commits/${head}`);
    if (!commit?.tree?.sha) throw new Error('Invalid GitHub commit response.');
    const treeSha = commit.tree.sha;
    const listing = await this.request(`${this.route}/trees/${treeSha}?recursive=1`);
    if (!listing || listing.truncated || !Array.isArray(listing.tree)) throw new Error('GitHub returned an incomplete repository tree. Sync stopped.');
    /** @type {Map<string, GitEntry>} */
    const tree = new Map(listing.tree.map((/** @type {GitEntry} */ item) => [item.path, item]));
    /** @type {Map<string, Group>} */
    const groups = new Map();
    const tracked = new Set([MANIFEST]);
    const manifest = tree.get(MANIFEST);
    const legacy = tree.has(LEGACY);
    if (manifest && legacy) throw new Error('Legacy sync data reappeared beside the manifest. Update all devices and resolve the old JSON before syncing.');
    if (manifest) {
      const data = JSON.parse((await this.readBlob(manifest)).toString('utf8'));
      if (data.version !== 2 || !Array.isArray(data.groups)) throw new Error('Invalid template manifest.');
      for (const item of data.groups) {
        if (!item || typeof item.name !== 'string' || item.id !== groupId(item.name) || !Array.isArray(item.entries)) {
          throw new Error('Invalid template group metadata.');
        }
        /** @type {Group} */
        const group = { version: 1, name: item.name, revision: head, roots: item.roots,
          entries: item.entries.map((/** @type {import('./templates').Entry} */ entry) => ({
            path: entry?.path, type: entry?.type, ...(entry?.type === 'file' ? { content: '', mode: entry.mode } : {})
          })) };
        validateGroup(group); validatePaths(group.entries.map(entry => entry.path));
        if (groups.has(group.name)) throw new Error('Duplicate remote template groups.');
        for (const entry of group.entries) if (entry.type === 'file') {
          const filename = `templates/${item.id}/${entry.path}`;
          tracked.add(filename);
          entry.content = (await this.readBlob(tree.get(filename))).toString('base64');
        }
        groups.set(group.name, group);
      }
    } else if (legacy) {
      const data = JSON.parse((await this.readBlob(tree.get(LEGACY))).toString('utf8'));
      if (data.version !== 1 || !Array.isArray(data.groups)) throw new Error('Invalid legacy template collection.');
      for (const group of data.groups) {
        validateGroup(group); validatePaths(group.entries.map((/** @type {import('./templates').Entry} */ entry) => entry.path));
        if (groups.has(group.name)) throw new Error('Duplicate remote template groups.');
        groups.set(group.name, group);
      }
    }
    return { head, treeSha, tree, groups, tracked, legacy };
  }

  /** @param {Snapshot} snapshot @param {Map<string, Group>} groups */
  async publish(snapshot, groups) {
    /** @type {Map<string, {bytes: Buffer, mode: string}>} */
    const desired = new Map();
    const metadata = [];
    for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      validateGroup(group); validatePaths(group.entries.map(entry => entry.path));
      const id = groupId(group.name);
      metadata.push({ id, name: group.name, roots: [...group.roots].sort(),
        entries: [...group.entries].sort((a, b) => a.path.localeCompare(b.path)).map(entry => {
          if (entry.type === 'file') desired.set(`templates/${id}/${entry.path}`, {
            bytes: Buffer.from(entry.content || '', 'base64'), mode: (entry.mode || 0) & 0o111 ? '100755' : '100644'
          });
          return { path: entry.path, type: entry.type, ...(entry.type === 'file' ? { mode: entry.mode } : {}) };
        }) });
    }
    desired.set(MANIFEST, { bytes: Buffer.from(JSON.stringify({ version: 2, groups: metadata }, null, 2) + '\n'), mode: '100644' });
    // Only paths owned by the manifest may be replaced; unrelated repository files are preserved.
    for (const filename of desired.keys()) {
      if (snapshot.tree.has(filename) && !snapshot.tracked.has(filename)) throw new Error(`Untracked repository path would be overwritten: ${filename}`);
      for (let parent = filename.slice(0, filename.lastIndexOf('/')); parent; parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '') {
        if (snapshot.tree.has(parent) && snapshot.tree.get(parent)?.type !== 'tree') throw new Error(`Repository file blocks template directory: ${parent}`);
      }
      if (snapshot.tree.get(filename)?.type === 'tree') throw new Error(`Repository directory blocks template file: ${filename}`);
    }
    /** @type {{path: string, mode: string, type: string, sha: string | null}[]} */
    const changes = [];
    const known = new Set([...snapshot.tree.values()].filter(item => item.type === 'blob').map(item => item.sha));
    for (const [filename, file] of desired) {
      const sha = blobSha(file.bytes);
      const previous = snapshot.tree.get(filename);
      if (previous?.sha === sha && previous.mode === file.mode) continue;
      if (!known.has(sha)) {
        const blob = await this.request(`${this.route}/blobs`, 'POST', { encoding: 'base64', content: file.bytes.toString('base64') });
        if (blob?.sha !== sha) throw new Error('GitHub did not confirm the uploaded file checksum.');
        known.add(sha);
      }
      changes.push({ path: filename, type: 'blob', mode: file.mode, sha });
    }
    for (const filename of snapshot.tracked) if (!desired.has(filename) && snapshot.tree.has(filename)) {
      changes.push({ path: filename, type: 'blob', mode: snapshot.tree.get(filename)?.mode || '100644', sha: null });
    }
    if (snapshot.legacy) changes.push({ path: LEGACY, type: 'blob', mode: '100644', sha: null });
    if (!changes.length) return;
    const tree = await this.request(`${this.route}/trees`, 'POST', { base_tree: snapshot.treeSha, tree: changes });
    if (!tree?.sha) throw new Error('GitHub did not create the template tree.');
    const commit = await this.request(`${this.route}/commits`, 'POST', {
      message: snapshot.legacy ? 'Migrate VS Templater templates to files' : 'Sync VS Templater templates',
      tree: tree.sha, parents: [snapshot.head]
    });
    if (!commit?.sha) throw new Error('GitHub did not create the template commit.');
    await this.request(`${this.route}/refs/heads/${this.branch}`, 'PATCH', { sha: commit.sha, force: false });
  }
}

module.exports = { GitHubStorage, blobSha, groupId, MANIFEST, LEGACY };
