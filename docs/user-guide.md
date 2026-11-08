# VS Templater User Guide

VS Templater saves project files and folders in named groups so you can reuse them in other projects. Each template is an independent snapshot: changing the original file does not change the saved template.

This guide covers **version 0.5.2**.

## Install and get started

1. Open the VS Code Command Palette with `Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on Windows/Linux.
2. Run **Extensions: Install from VSIX...** and select `vstemplater-0.5.2.vsix`.
3. After upgrading, close and reopen all VS Code windows. This is especially important when upgrading from 0.4: no window should continue running the old sync implementation.
4. Open a trusted local project folder. The **Templates** section appears in Explorer.

To build the installation package from source, run these commands in the extension's source directory:

```sh
npm ci
npm run check
npm test
npm run package
```

The VSIX file is created in the project root. To run a development instance, open the source project in VS Code and press `F5`.

## Create a group and add files

1. Right-click a project file or folder in Explorer.
2. Select **Add to Templates**.
3. Select an existing group, or create and name a new group.
4. Expand the group in **Templates** to browse its saved paths and files.

Parent paths are saved relative to the project root. For example, adding `src/components/Button` preserves that path. Adding to the same group again updates matching files and adds new ones. Previously saved files that have disappeared from the source folder remain in the group; use **Delete** to remove them.

## Import a template into a project

Right-click the destination folder and select **Import from Template**. Choose a group from the list, then select an import mode:

| Option | Result |
| --- | --- |
| **Keep original paths** | Recreates saved paths under the destination. |
| **Choose a new path** | Lets you choose a destination within the project. For a group with one saved root, that root's parent directories are removed. |

For example, suppose the `UI` group contains only `src/components/Button`:

```text
Original paths, destination packages/web:
packages/web/src/components/Button/...

New path, destination packages/web:
packages/web/Button/...
```

The extension imports the group's contents without creating a folder named `UI`. Groups with multiple roots retain their relative paths at the new destination. The folder picker selects an existing directory; create a new destination folder first if needed.

Right-clicking a file uses its parent folder as the destination. Running the command from the Command Palette prompts for a destination. In a workspace with multiple project roots, you may also need to select the project.

Existing folders merge with imported folders. Replacing existing files requires confirmation; cancelling leaves the destination untouched. Save or close destination files with unsaved changes before importing.

## Manage groups and files

Right-click a group, folder or file in **Templates**:

| Command | Action |
| --- | --- |
| **Import into Project** | Imports only the selected group, folder or file. |
| **Rename** | Renames the selected item. Renaming a folder updates its descendants' paths. |
| **Delete** | Deletes the selected item after confirmation. Deleting a folder includes its descendants. |
| **Edit Template File** | Opens a template file in the editor. |

Click a file, edit it, and Save to update the stored template. The original project file remains unchanged. Unsaved template changes block affected rename/delete operations and prevent sync.

Deleting the last file leaves an empty group. To remove the group itself, select **Delete** on its name. **Refresh Templates** reloads the local list; it does not sync or recover data from GitHub.

You can browse and manage saved templates without an open project. **Add** and **Import** require an open local project; otherwise, the extension displays `Open a project first.`

## Connect to GitHub

1. Run **Templates: Connect GitHub Sync** from the Command Palette.
2. Use your VS Code GitHub account and grant repository access if prompted. The extension does not store the token itself.
3. Select **Create private repository**, or select **Use existing private repository** and enter `owner/name`.
4. An existing repository must allow write access and have an initialized default branch with at least one commit.
5. Run **Templates: Sync Now** to check the connection. A successful sync displays `Templates synced with GitHub.`

Use a dedicated private repository for your templates. The extension's source repository and your template repository serve different purposes. Sync uses VS Code's GitHub authentication, but the extension transfers the templates itself; this is separate from VS Code Settings Sync.

GitHub storage layout:

```text
.vstemplater/
  manifest.json
templates/
  <group-id>/
    src/components/Button/...
```

Template contents are stored as real, readable files. The manifest holds group names, paths, file permission bits and empty-directory metadata. Group IDs organize the sync repository and do not create extra directories when importing. The extension does not encrypt file contents.

Sync runs at startup, shortly after local changes, and every minute. Offline changes remain local and are retried. To use another device, install the same extension version and connect it to the same repository.

## Conflicts, deletions and disconnecting

If a group changes on both sides, automatic sync pauses. **Sync Now** offers:

- **Keep local group**: choose the entire local version of the group.
- **Use GitHub group**: choose the entire GitHub version of the group.

Resolution applies to the whole group; files are not merged line by line. Cancelling preserves both versions.

If a sync would remove every remaining group, automatic sync pauses. During manual sync, choose **Keep remaining templates** to restore the empty side from the remaining data. Choose **Delete all synced templates** only when you intend to delete the entire collection.

**Templates: Disconnect GitHub Sync** disconnects sync while retaining both local and remote data. Disconnect before switching accounts or repositories.

## Troubleshooting

| Problem | Action |
| --- | --- |
| No project is open | Open a local project folder. |
| A template file has unsaved changes | Save it, or preserve any edits you need before closing the editor. |
| A group changed in another window | Refresh and select the item again. For a stale editor, preserve unsaved edits and reopen the file. |
| GitHub network or access error | Check your network, account and private repository permissions, then retry Sync Now. |
| Legacy JSON reappears beside the manifest | Update and restart every connected device and window. Compare the old JSON with the current data and make a backup before removing it. |
| The manifest is missing | Stop sync and restore a valid manifest together with its corresponding files from Git history. |
| Groups have disappeared | Refresh cannot recover deleted data. Disconnect sync and inspect the last intact commit in your template repository. |

For recovery, first download an intact snapshot into a separate folder and inspect its files. The manifest and its referenced files must agree. Restore them in a new commit to preserve history. Before reconnecting, make sure every client runs the updated extension.

## Limitations

- Only local desktop projects are supported. SSH, WSL, containers and virtual workspaces are outside the supported scope.
- `.git`, `node_modules`, `.env` and `.env.*` are excluded when collecting files, except `.env.example`. These exclusions do not use `.gitignore`.
- Symbolic links and special files are unsupported. Nonportable paths and names that conflict by case are rejected.
- The previous 750 KB collection cap has been removed, but GitHub limits and available memory still apply.
- Each file import is atomic, but an entire group import is not a transaction. If copying fails midway, the error reports how many files were imported.
- You can edit existing tracked files on GitHub. Add, delete and rename templates through the extension to keep the manifest consistent.

See the [changelog](../CHANGELOG.md) for version history and the [README](../README.md) for development details.
