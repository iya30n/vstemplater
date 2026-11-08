const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

/** @typedef {{path: string, type: 'file' | 'directory', content?: string, mode?: number}} Entry */
/** @typedef {{version: 1, name: string, revision: string, roots: string[], entries: Entry[]}} Group */
/** @typedef {{path: string, stamp: string}} Conflict */

/** @param {unknown} value @returns {asserts value is string} */
function validatePath(value) {
  if (typeof value !== 'string' || !value || value.split('/').some(part =>
    !part || part === '.' || part === '..' || /[\\\x00-\x1f<>:"|?*]/.test(part) ||
    /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
    throw new Error(`Invalid template path: ${value}`);
  }
}

/** @param {string[]} paths */
function validatePaths(paths) {
  const seen = new Set();
  const portable = new Map();
  for (const itemPath of paths) {
    validatePath(itemPath);
    if (seen.has(itemPath)) throw new Error(`Conflicting template paths: "${itemPath}" is repeated.`);
    seen.add(itemPath);
    let prefix = '';
    for (const part of itemPath.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const key = prefix.normalize('NFC').toLowerCase();
      const previous = portable.get(key);
      if (previous !== undefined && previous !== prefix) {
        throw new Error(`Conflicting template paths: "${previous}" and "${prefix}". Rename one item before continuing.`);
      }
      portable.set(key, prefix);
    }
  }
}

/** @param {Group} group */
function validateGroup(group) {
  if (!group || group.version !== 1 || typeof group.name !== 'string' || !group.name.trim() ||
      /[\x00-\x1f]/.test(group.name) || typeof group.revision !== 'string' ||
      !Array.isArray(group.entries) || !Array.isArray(group.roots)) throw new Error('Invalid template data.');
  for (const root of group.roots) validatePath(root);
  const entries = new Map();
  for (const entry of group.entries) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid template entry.');
    validatePath(entry.path);
    if (entries.has(entry.path) || !['file', 'directory'].includes(entry.type) ||
        (entry.type === 'file' && (typeof entry.content !== 'string' ||
          Buffer.from(entry.content, 'base64').toString('base64') !== entry.content ||
          typeof entry.mode !== 'number' || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777))) {
      throw new Error('Invalid template entry.');
    }
    entries.set(entry.path, entry);
  }
  if (group.roots.some(root => !entries.has(root)) ||
      group.entries.some(entry => !group.roots.some(root => entry.path === root || entry.path.startsWith(`${root}/`)))) {
    throw new Error('Invalid template roots.');
  }
  for (const entry of group.entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== '.') {
      if (entries.get(parent)?.type === 'file') throw new Error(`File/folder type conflict: ${parent}`);
      parent = path.posix.dirname(parent);
    }
  }
}

/** @param {string} filename */
function excluded(filename) {
  filename = filename.toLowerCase();
  return filename === '.git' || filename === 'node_modules' ||
    (filename === '.env' || filename.startsWith('.env.')) && filename !== '.env.example';
}

/** @param {string} project @param {string} source */
async function collect(project, source) {
  const relative = path.relative(project, source);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The selected item must be inside the open project.');
  }
  if (relative.split(path.sep).some(excluded)) throw new Error('This path is excluded from templates.');
  await assertSafePath(project, source);
  /** @type {Entry[]} */
  const entries = [];
  /** @type {string[]} */
  const skipped = [];
  /** @param {string} filename @param {string} stored */
  async function visit(filename, stored) {
    const info = await fs.lstat(filename);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error(`Symbolic links and special files are not supported: ${stored}`);
    }
    if (stored) {
      validatePath(stored);
      entries.push(info.isDirectory() ? { path: stored, type: 'directory' } :
        { path: stored, type: 'file', content: (await fs.readFile(filename)).toString('base64'), mode: info.mode & 0o777 });
    }
    if (info.isDirectory()) {
      for (const child of (await fs.readdir(filename)).sort()) {
        const childPath = stored ? `${stored}/${child}` : child;
        if (excluded(child)) skipped.push(childPath);
        else await visit(path.join(filename, child), childPath);
      }
    }
  }
  const stored = relative.split(path.sep).join('/');
  await visit(source, stored);
  const roots = stored ? [stored] : entries.filter(entry => !entry.path.includes('/')).map(entry => entry.path);
  return { roots, entries, skipped };
}

/** Reject links below the workspace root.
 * @param {string} root @param {string} target
 */
async function assertSafePath(root, target) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('The destination must stay inside the project.');
  }
  const resolvedRoot = await fs.realpath(root);
  // The OS may expose the project through a symlink (for example /tmp on macOS).
  let current = resolvedRoot;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    const info = await fs.lstat(current).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${current}`);
  }
}

class TemplateStore {
  /** @param {string} directory */
  constructor(directory) { this.directory = directory; }

  /** @param {string} name */
  filename(name) {
    return path.join(this.directory, `${createHash('sha256').update(name).digest('hex')}.json`);
  }

  /** @param {string} name @returns {Promise<Group | undefined>} */
  async get(name) {
    // shortcut: groups are loaded in memory; use streamed storage if large collections become necessary.
    let text;
    try { text = await fs.readFile(this.filename(name), 'utf8'); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return undefined;
      throw error;
    }
    /** @type {Group} */
    const group = JSON.parse(text);
    validateGroup(group);
    if (group.name !== name) throw new Error('Invalid template group name.');
    return group;
  }

  async list() {
    const files = await fs.readdir(this.directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    /** @type {Group[]} */
    const groups = [];
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const { name } = JSON.parse(await fs.readFile(path.join(this.directory, file), 'utf8'));
      if (typeof name !== 'string' || this.filename(name) !== path.join(this.directory, file)) {
        throw new Error('Invalid template group.');
      }
      const group = await this.get(name);
      if (group) groups.push(group);
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** @param {string} name @param {{roots: string[], entries: Entry[]}} addition @param {string | undefined} revision */
  async save(name, addition, revision) {
    name = name.trim().normalize('NFC');
    if (!name || /[\x00-\x1f]/.test(name)) throw new Error('Enter a valid template group name.');
    return this.update(name, revision, previous => {
      const entries = new Map((previous?.entries || []).map(entry => [entry.path, entry]));
      for (const entry of addition.entries) {
        const existing = entries.get(entry.path);
        if (existing && existing.type !== entry.type) throw new Error(`File/folder type conflict: ${entry.path}`);
        entries.set(entry.path, entry);
      }
      const candidates = [...new Set([...(previous?.roots || []), ...addition.roots])];
      const roots = candidates.filter(item => !candidates.some(parent => item.startsWith(`${parent}/`)));
      return { name, roots, entries: [...entries.values()] };
    });
  }

  /** @param {string} name @param {string | undefined} revision
   * @param {(previous: Group | undefined) => {name: string, roots: string[], entries: Entry[]} | undefined} change
   */
  async update(name, revision, change) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = await fs.open(path.join(this.directory, '.lock'), 'wx', 0o600).catch(error => {
      if (error.code === 'EEXIST') throw new Error('Template storage is busy. Retry; after a crash, remove the .lock file from template storage.');
      throw error;
    });
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    try {
      const previous = await this.get(name);
      if (previous?.revision !== revision) throw new Error('This group changed in another window. Please retry.');
      const changed = change(previous);
      if (!changed) {
        await fs.unlink(this.filename(name));
        return;
      }
      /** @type {Group} */
      const group = { ...changed, version: 1, revision: randomUUID() };
      validateGroup(group);
      validatePaths(group.entries.map(entry => entry.path));
      if (group.name !== name && await this.get(group.name)) throw new Error('A group with that name already exists.');
      await fs.writeFile(temporary, JSON.stringify(group), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.filename(group.name));
      // Commit the new name before removing the old one so interruption cannot lose the group.
      if (group.name !== name) await fs.unlink(this.filename(name));
      return group;
    } finally {
      await fs.rm(temporary, { force: true });
      await lock.close();
      await fs.rm(path.join(this.directory, '.lock'), { force: true });
    }
  }

  /** @param {Group} group @param {string} itemPath */
  async remove(group, itemPath) {
    return this.update(group.name, group.revision, current => {
      if (!current) throw new Error('This template group no longer exists.');
      if (!itemPath) return undefined;
      validatePath(itemPath);
      if (!current.entries.some(entry => entry.path === itemPath || entry.path.startsWith(`${itemPath}/`))) {
        throw new Error('This template item no longer exists.');
      }
      const entries = current.entries.filter(entry => entry.path !== itemPath && !entry.path.startsWith(`${itemPath}/`));
      return { ...current, entries, roots: current.roots.filter(root => entries.some(entry => entry.path === root)) };
    });
  }

  /** @param {Group} group @param {string} itemPath @param {string} newName */
  async rename(group, itemPath, newName) {
    newName = newName.trim().normalize('NFC');
    if (!newName || /[\x00-\x1f]/.test(newName)) throw new Error('Enter a valid name.');
    return this.update(group.name, group.revision, current => {
      if (!current) throw new Error('This template group no longer exists.');
      if (!itemPath) return { ...current, name: newName };
      validatePath(itemPath);
      validatePath(newName);
      if (newName.includes('/')) throw new Error('Enter a name, not a path.');
      const parent = path.posix.dirname(itemPath);
      const target = parent === '.' ? newName : `${parent}/${newName}`;
      const selected = current.entries.filter(entry => entry.path === itemPath || entry.path.startsWith(`${itemPath}/`));
      if (!selected.length) throw new Error('This template item no longer exists.');
      const rest = current.entries.filter(entry => !selected.includes(entry));
      if (rest.some(entry => entry.path === target || entry.path.startsWith(`${target}/`))) {
        throw new Error('An item with that name already exists.');
      }
      const replace = (/** @type {string} */ value) => value === itemPath || value.startsWith(`${itemPath}/`) ? target + value.slice(itemPath.length) : value;
      return { ...current, roots: current.roots.map(replace), entries: [
        ...rest, ...selected.map(entry => ({ ...entry, path: replace(entry.path) }))
      ] };
    });
  }

  /** @param {Group} group @param {string} itemPath @param {Uint8Array} content */
  async edit(group, itemPath, content) {
    return this.update(group.name, group.revision, current => {
      if (!current) throw new Error('This template group no longer exists.');
      const entry = current.entries.find(entry => entry.path === itemPath && entry.type === 'file');
      if (!entry) throw new Error('This template file no longer exists.');
      return { ...current, entries: current.entries.map(item => item === entry ? { ...item, content: Buffer.from(content).toString('base64') } : item) };
    });
  }
}

/** @param {Group} group @param {string} itemPath @returns {Group} */
function selectItem(group, itemPath) {
  if (!itemPath) return group;
  validatePath(itemPath);
  const entries = group.entries.filter(entry => entry.path === itemPath || entry.path.startsWith(`${itemPath}/`));
  if (!entries.length) throw new Error('This template item no longer exists.');
  if (!entries.some(entry => entry.path === itemPath)) entries.unshift({ path: itemPath, type: 'directory' });
  return { ...group, roots: [itemPath], entries };
}

/** @param {Group} group @param {boolean} original */
function importEntries(group, original) {
  const prefix = !original && group.roots.length === 1 ? path.posix.dirname(group.roots[0]) : '.';
  const entries = group.entries.filter(entry => original || prefix === '.' ||
    group.roots.some(root => entry.path === root || entry.path.startsWith(`${root}/`)));
  return entries.map(entry => ({ ...entry, path: prefix === '.' ? entry.path : entry.path.slice(prefix.length + 1) }));
}

/** @param {string} project @param {string} destination @param {Entry[]} entries */
async function inspectImport(project, destination, entries) {
  validatePaths(entries.map(entry => entry.path));
  await assertSafePath(project, destination);
  /** @type {Conflict[]} */
  const conflicts = [];
  for (const entry of entries) {
    const target = path.join(destination, ...entry.path.split('/'));
    await assertSafePath(project, target);
    const info = await fs.lstat(target, { bigint: true }).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info && (entry.type === 'directory' ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`File/folder type conflict: ${entry.path}`);
    }
    if (info && entry.type === 'file') conflicts.push({ path: entry.path,
      stamp: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` });
  }
  return conflicts;
}

/** @param {string} project @param {string} destination @param {Entry[]} entries @param {Conflict[]} approved */
async function writeImport(project, destination, entries, approved) {
  const approvals = new Map(approved.map(item => [item.path, item.stamp]));
  const conflicts = await inspectImport(project, destination, entries);
  if (conflicts.length !== approvals.size || conflicts.some(item => approvals.get(item.path) !== item.stamp)) {
    throw new Error('The destination changed. Please retry and confirm replacements.');
  }
  let written = 0;
  try {
    for (const entry of [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      const target = path.join(destination, ...entry.path.split('/'));
      await assertSafePath(project, target);
      if (entry.type === 'directory') await fs.mkdir(target, { recursive: true });
      else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = path.join(path.dirname(target), `.vstemplater-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, Buffer.from(entry.content || '', 'base64'), { flag: 'wx', mode: entry.mode });
          const current = await inspectImport(project, destination, [entry]);
          if (current[0]?.stamp !== approvals.get(entry.path)) throw new Error('The destination changed. Please retry and confirm replacements.');
          if (approvals.has(entry.path)) await fs.rename(temporary, target);
          else await fs.link(temporary, target);
        } finally { await fs.rm(temporary, { force: true }); }
        written++;
      }
    }
  } catch (error) {
    throw new Error(`Import stopped after ${written} file(s); some directories may have been created. ${/** @type {Error} */ (error).message}`);
  }
  return written;
}

module.exports = { TemplateStore, collect, importEntries, inspectImport, writeImport, validatePath, selectItem, validateGroup, validatePaths };
