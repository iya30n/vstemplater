# Changelog

## 0.5.2

- Pause automatic sync when a merge would remove every remaining group, even with a valid empty manifest.
- Manual sync offers Keep remaining templates or explicit deletion; cancellation preserves data and the sync baseline.
- Update and restart all VS Code windows before using the file-based sync format; an older running client can recreate legacy JSON and propagate deletions.

## 0.5.1

- Stop syncing when the remote manifest disappears from an established collection, instead of interpreting it as deletion of every group.
- Preserve local data and leave the remote branch untouched when template files exist without their manifest.
- This guard prevents further loss; it does not automatically restore previously deleted groups.

## 0.5.0

- Store actual template files in GitHub with a metadata-only manifest, preserving paths, binary content, permissions and empty directories.
- Reuse unchanged Git blobs and publish changes atomically without force-pushing or overwriting unrelated files.
- Automatically migrate legacy JSON in one commit; failed migration leaves the previous remote snapshot intact.
- Remove the 750 KB collection cap and normalize group comparisons across metadata property ordering.

## 0.4.0

- Added optional GitHub sync using the VS Code account, private repository connection/creation, automatic retry, status and manual sync.
- Added three-way group conflict detection, deletion propagation and validation before applying remote data.
- Initial sync supports collections up to 750 KB and whole-group conflict choices.

## 0.3.0

- Recheck destination file identity and timestamps after replacement confirmation and before writing each file. Changes during the prompt require a fresh confirmation.
- Block imports targeting unsaved files in the current VS Code window, including edits made while the confirmation prompt is open.
- Reject duplicate template paths and names differing only by case or Unicode normalization before import or storage updates, including implicit parent folders.
- Apply default path exclusions regardless of case, while preserving `.env.example`.
- Added multi-root selection/cancellation checks and a simulated filesystem failure test covering partial-copy reporting, temporary-file cleanup and retry.

## 0.2.0

- Added the Templates tree view in Explorer, grouped by template name and saved path, with automatic refresh.
- Added selective group/folder/file import, rename, and confirmed deletion. Existing groups remain compatible.
- Added direct template editing through VS Code's file system provider; Save updates the template without changing the source project.
- Prevented stale editor saves from overwriting newer template content, and blocked rename/delete of files with unsaved changes.
- Enabled template management without an open project. Adding and importing still require an open project.

## 0.1.2

- Made the project-required notification English-only. All extension UI messages are now in English.

## 0.1.1

- Fixed Add/Import remaining busy while a success, empty-list or error notification stayed open. Informational notifications no longer wait for dismissal; replacement confirmations still require an answer.
- Added regression tests that keep notifications open while running consecutive operations.

## 0.1.0

- Initial local template storage and import commands.
