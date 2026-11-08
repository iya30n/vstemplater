# VS Templater

Save independent copies of project files and folders in named template groups. Import a group into another local project, preserving saved paths or choosing a new destination. Templates persist outside the workspace in VS Code's extension global storage.

## Install and try

In VS Code, run **Extensions: Install from VSIX...** from the Command Palette and select `vstemplater-0.5.2.vsix`, then restart all VS Code windows so no older sync client remains active. Existing template groups are preserved. Alternatively, open this source folder and press **F5** to launch an Extension Development Host.

Right-click a project file or folder and select **Add to Templates**. Pick an existing group or create a new one. Entering an existing name also adds to that group. Both commands are available in the Command Palette under **Templates**.

Right-click the destination and select **Import from Template**, pick a group, then choose:

- **Keep original paths**: recreate paths relative to the clicked folder (or the parent of a clicked file).
- **Choose a new path**: select a destination folder inside the same project. A group containing one selected root, such as `src/components/Button`, imports as `Button/`. A group with multiple roots keeps their relative paths to preserve its internal structure.

For example, importing `src/components/Button` with original paths into `packages/web` creates `packages/web/src/components/Button`. No directory named after the template group is created. From the Command Palette, a destination picker appears for both modes. The folder picker selects an existing folder; create a new folder there first when necessary.

Existing folders merge. Existing files require a replacement confirmation; cancelling leaves the destination untouched. Adding a folder again merges its current files into the group; it does not remove previously saved files that are now absent from the source.

Unsaved destination files in the current VS Code window must be saved or closed first. Destination file identity, size and timestamps are checked again after confirmation and immediately before each file replacement. If a file changes while the confirmation is open, the import stops and asks you to retry. This check does not lock files against other programs during the copy.

## Templates view

The **Templates** section appears inside Explorer. Expand a group to browse its saved paths, including parent folders. The refresh button reloads the list; changes from this window or another VS Code window also refresh it automatically.

Right-click a group, folder or file for **Import into Project**, **Rename**, or **Delete**. Rename changes the selected item's name, preserving its parent path. Renaming a folder updates all its descendants. Deleting a folder removes its descendants; deleting the last item leaves an empty group. All deletions require confirmation and affect only the saved template.

Click a file, or select **Edit Template File**, to open it in the editor. Save normally to update the template. The original project file is unaffected. Images and other binary formats use VS Code's available viewers/editors.

**Import into Project** imports only the selected group, folder or file. Choose a project when multiple workspace folders are open, then choose original paths or a new destination. Selecting a single file with a new destination copies only its filename; selecting a folder keeps that folder's name and contents.

Browsing, renaming, deleting and editing saved templates work without an open project. Importing and adding project files require an open local project. Rename/delete are blocked while affected template documents have unsaved changes. If a file changes in another window, a stale editor cannot overwrite it: copy your unsaved edits and reopen the template before saving.

## Current boundaries

- Local desktop projects only; SSH, WSL, containers and virtual workspaces are not supported yet.
- GitHub sync is optional; local templates remain available offline.
- `.git`, `node_modules`, `.env`, and `.env.*` are excluded, except `.env.example`; exclusion matching is case-insensitive. Other hidden files are included. Symlinks and special files are rejected. `.gitignore` is not used as an exclusion list.
- Files are copied byte for byte, with file permission bits preserved where the OS supports them. Templates are snapshots; later source changes do not affect them.
- Paths are workspace-relative and must be portable across operating systems; absolute paths and Windows-reserved names are rejected.
- Template paths differing only by case or Unicode normalization are rejected before saving or importing. Older groups remain visible so conflicting items can be renamed or deleted.
- A project must be open for Add/Import. In a multi-root workspace, the context item determines the source project; Command Palette operations ask which project to use.
- Local storage uses one atomically replaced JSON document per group, including Base64 file contents. `shortcut: each group is loaded in memory, switch to streamed file storage if large template collections become a requirement.`
- Simultaneous group updates are guarded by a storage lock and revision check. After an interrupted process, a stale `.lock` file may need removal from the extension's `templates` storage directory while all VS Code windows are closed.
- Group rename saves the new group before removing the old name. An interruption between those operations can leave both names; neither version is discarded.
- Each file import is atomic, but the entire group import is not a transaction. If a filesystem error interrupts a copy, the error reports the number of files already imported. Use a test project for initial validation.

## Development

```sh
npm ci
npm run check
npm test
npm run package
```

Runtime uses only Node.js and VS Code APIs. There are no runtime npm dependencies. Packaging does not publish the extension or contact GitHub.

Manual checklists are in `docs/phase-1-test.md` through `docs/phase-4-test.md`.

An additional real VS Code smoke test is in `test/host/index.js`. Launch VS Code with this extension's development path and that tests directory, set `VSTEMPLATER_TEST_ROOT` to a new temporary directory, and use its `user` subdirectory for `--user-data-dir` and its `extensions` subdirectory for `--extensions-dir`. Open an empty project under that temporary directory. The test uses isolated storage to verify view activation, opening and saving a template document, local import and conflict inspection.

## GitHub sync

Run **Templates: Connect GitHub Sync**, then select an existing private repository (`owner/name`) or create one. The extension uses VS Code's built-in GitHub session and requests repository access when needed. Existing repositories must have an initialized default branch. No token is stored by this extension.

Actual template files are stored at `templates/<group-id>/<saved-path>`. `.vstemplater/manifest.json` maps stable name-derived group IDs to names, roots, permission bits and empty directories; it contains no file contents. Group directories exist only in the sync repository, never as wrappers when importing. Files are readable in GitHub and are not encrypted by the extension. Unchanged file contents are reused by Git hash; each sync publishes all changes in one commit and preserves unrelated repository files. After connecting, sync runs on startup, shortly after local changes, and every minute. **Templates: Sync Now** also runs it manually. The status-bar item shows errors and pending conflicts. Offline changes remain local and retry automatically.

Conflicts pause automatic sync. Run Sync Now and choose the **entire local group** or **entire GitHub group**; cancelling preserves both versions. Deletions propagate after connection. Disconnect before switching repositories or accounts; disconnecting retains local templates and remote data.

Version 0.5 automatically migrates the old `.vstemplater.json` on the next successful sync. The same commit adds the real files and removes the old JSON; its history remains in Git. Update every connected device/window before syncing, because older versions use the old format. If old JSON reappears beside the new manifest, sync stops to prevent silently losing old-client edits.

Existing tracked files may be edited on GitHub. Add, delete and rename templates through the extension so the manifest stays consistent.

Current limits: the old 750 KB collection cap is removed; GitHub API limits still apply. Local collections are still loaded into memory. An incomplete GitHub tree stops sync safely. Conflict resolution is per group, not per file. Sync applies local groups individually; interruption can require retry or conflict selection, while GitHub retains the uploaded snapshot. Use a dedicated private test repository for first validation. Real GitHub authentication and network writes require the manual checklist in `docs/phase-4-test.md`.

If sync would remove every remaining group, automatic sync pauses. Run **Templates: Sync Now** and choose **Keep remaining templates** to restore the empty side, or **Delete all synced templates** only when the complete deletion is intended. Cancelling keeps the remaining data.
