const vscode = require('vscode');
const { createHash } = require('node:crypto');
const { GitHubStorage, MANIFEST } = require('./github-storage');

/** @param {import('./templates').Group | undefined} group */
function digest(group) {
  return group ? createHash('sha256').update(JSON.stringify({ name: group.name,
    roots: [...group.roots].sort(), entries: [...group.entries].sort((a, b) => a.path.localeCompare(b.path)).map(entry => ({
      path: entry.path, type: entry.type, ...(entry.type === 'file' ? { content: entry.content, mode: entry.mode } : {})
    })) })).digest('hex') : '';
}

/** @param {import('vscode').ExtensionContext} context @param {import('./templates').TemplateStore} store @param {() => void} refresh */
function registerSync(context, store, refresh) {
  let running = false;
  let connecting = false;
  let attention = false;
  let disposed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pending;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'vstemplater.sync';
  status.text = '$(cloud) Templates';
  status.tooltip = 'Connect GitHub template sync';
  status.show();

  /** @param {string} token @param {string} route @param {string} [method] @param {unknown} [body] */
  async function request(token, route, method = 'GET', body) {
    const response = await fetch(`https://api.github.com${route}`, { method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    if (response.status === 404 && method === 'GET') return undefined;
    if (!response.ok) throw new Error(`GitHub request failed (${response.status}). Check access and retry Sync Now.`);
    return response.json();
  }

  async function connect() {
    if (running || connecting) return;
    if (context.globalState.get('githubSync')) throw new Error('Disconnect GitHub sync before connecting another repository.');
    connecting = true;
    try {
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
    const action = await vscode.window.showQuickPick(['Use existing private repository', 'Create private repository'], { placeHolder: 'Where should templates sync?' });
    if (!action) return;
    let repo;
    if (action === 'Create private repository') {
      const name = await vscode.window.showInputBox({ prompt: 'New private repository name', value: 'vstemplater-templates',
        validateInput: value => /^[A-Za-z0-9_.-]+$/.test(value) ? undefined : 'Enter a valid repository name.' });
      if (!name) return;
      const created = await request(session.accessToken, '/user/repos', 'POST', { name, private: true, auto_init: true });
      repo = created.full_name;
    } else repo = await vscode.window.showInputBox({ prompt: 'Private repository (owner/name)',
      validateInput: value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? undefined : 'Use owner/name.' });
    if (!repo) return;
    const metadata = await request(session.accessToken, `/repos/${repo}`);
    if (!metadata?.private || !metadata.permissions?.push) throw new Error('Select a private repository with write access.');
    await context.globalState.update('githubSync', { repo: metadata.full_name, branch: metadata.default_branch,
      account: session.account.id, base: {} });
    attention = false;
    } finally { connecting = false; }
    await sync(true);
  }

  /** @param {boolean} manual */
  async function sync(manual) {
    if (running || connecting || disposed || (!manual && attention)) return;
    const config = context.globalState.get('githubSync');
    if (!config) { if (manual) await connect(); return; }
    running = true;
    status.text = '$(sync~spin) Templates';
    try {
      if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'vstemplater')) {
        throw new Error('Save or close unsaved template files before syncing.');
      }
      const session = await vscode.authentication.getSession('github', ['repo'], manual ? { createIfNone: true } : { silent: true });
      if (!session) throw new Error('Sign in to GitHub and run Sync Now.');
      if (session.account.id !== config.account) throw new Error('The GitHub account changed. Connect the repository again.');
      const metadata = await request(session.accessToken, `/repos/${config.repo}`);
      if (!metadata?.private) throw new Error('Sync requires a private repository.');
      const local = new Map((await store.list()).map(group => [group.name, group]));
      const github = new GitHubStorage((route, method, body) => request(session.accessToken, route, method, body),
        config.repo, config.branch, local.values());
      const snapshot = await github.read();
      if (!snapshot.legacy && !snapshot.tree.has(MANIFEST) &&
          (Object.keys(config.base).length || [...snapshot.tree.keys()].some(name => name.startsWith('templates/')))) {
        throw new Error('The GitHub template manifest is missing. Sync stopped to preserve local templates. Restore the manifest from GitHub history before retrying.');
      }
      const remote = snapshot.groups;
      const merged = new Map(local);
      for (const name of new Set([...Object.keys(config.base), ...local.keys(), ...remote.keys()])) {
        const left = digest(local.get(name)), right = digest(remote.get(name)), base = Object.hasOwn(config.base, name) ? config.base[name] : '';
        let useRemote = left === base;
        if (left !== right && left !== base && right !== base) {
          if (!manual) { attention = true; throw new Error('Conflicting template changes. Run Sync Now to choose a version.'); }
          const choice = await vscode.window.showQuickPick(['Keep local group', 'Use GitHub group'], {
            placeHolder: `Conflict: ${name} — choose the entire group (${!left ? 'local deleted' : !right ? 'GitHub deleted' : 'both changed'})` });
          if (!choice) { attention = true; throw new Error('Sync cancelled. No changes were applied.'); }
          useRemote = choice === 'Use GitHub group';
        }
        if (useRemote) { const group = remote.get(name); if (group) merged.set(name, group); else merged.delete(name); }
      }
      if (!merged.size && (local.size || remote.size)) {
        attention = true;
        if (!manual) throw new Error('Sync would delete every template group. Run Sync Now to review.');
        const choice = await vscode.window.showQuickPick(['Keep remaining templates', 'Delete all synced templates'], {
          placeHolder: 'One copy is empty. Keep the remaining groups or delete every synced template?'
        });
        if (!choice) throw new Error('Sync cancelled. No changes were applied.');
        if (choice === 'Keep remaining templates') {
          for (const [name, group] of [...remote, ...local]) merged.set(name, group);
        }
      }
      const current = new Map((await store.list()).map(group => [group.name, group]));
      if (current.size !== local.size || [...local].some(([name, group]) => current.get(name)?.revision !== group.revision)) {
        throw new Error('Local templates changed during sync. Retry Sync Now.');
      }
      if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'vstemplater')) {
        throw new Error('Save or close unsaved template files before syncing.');
      }
      await github.publish(snapshot, merged);
      for (const name of new Set([...local.keys(), ...merged.keys()])) {
        if (digest(local.get(name)) !== digest(merged.get(name))) {
          if (vscode.workspace.textDocuments.some(doc => doc.isDirty && doc.uri.scheme === 'vstemplater')) {
            throw new Error('A template editor changed during sync. Save it and retry.');
          }
          await store.update(name, local.get(name)?.revision, () => merged.get(name));
        }
      }
      await context.globalState.update('githubSync', { ...config,
        base: Object.fromEntries([...merged].map(([name, group]) => [name, digest(group)])) });
      attention = false;
      status.text = '$(cloud) Templates'; status.tooltip = `Synced with ${config.repo}`;
      refresh();
      if (manual) void vscode.window.showInformationMessage('Templates synced with GitHub.');
    } catch (error) {
      status.text = '$(warning) Templates'; status.tooltip = /** @type {Error} */ (error).message;
      if (manual) void vscode.window.showErrorMessage(`Templates sync: ${/** @type {Error} */ (error).message}`);
    } finally { running = false; }
  }

  const timer = setInterval(() => void sync(false), 60000);
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(context.globalStorageUri, 'templates/*.json'));
  const schedule = () => { if (running || disposed) return; clearTimeout(pending); pending = setTimeout(() => void sync(false), 2000); };
  context.subscriptions.push(status, watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule),
    vscode.commands.registerCommand('vstemplater.sync', async () => {
      try { await sync(true); } catch (error) { void vscode.window.showErrorMessage(`Templates sync: ${/** @type {Error} */ (error).message}`); }
    }),
    vscode.commands.registerCommand('vstemplater.connect', async () => {
      try { await connect(); } catch (error) { void vscode.window.showErrorMessage(`Templates sync: ${/** @type {Error} */ (error).message}`); }
    }),
    vscode.commands.registerCommand('vstemplater.disconnect', async () => {
      if (running || connecting) { void vscode.window.showInformationMessage('Wait for the current sync to finish.'); return; }
      await context.globalState.update('githubSync', undefined);
      status.text = '$(cloud) Templates'; status.tooltip = 'GitHub sync disconnected';
    }),
    new vscode.Disposable(() => { disposed = true; clearInterval(timer); clearTimeout(pending); }));
  void sync(false);
}
module.exports = { registerSync, digest };
