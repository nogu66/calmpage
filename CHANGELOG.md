# Changelog

All notable changes to Calmpage are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Find and replace across the folder in the sidebar (⇧⌘F, or Edit → Find in Folder), with match case, whole word, and regular expressions. Results are grouped by file; Replace All asks first, changes open files in the editor, and writes the others to disk.
- Editor tabs for the files you open. A dot marks unsaved changes and an underline marks the root document. Close a tab with ×, ⌘W, or a middle click (unsaved changes are saved first), and move between tabs with ⌃Tab / ⌃⇧Tab or ⇧⌘[ / ⇧⌘]. The tabs come back the next time you open the folder.
- Local file history: every save keeps a version of the file in `~/Library/Application Support/Calmpage/history/` (up to 50 per file, for 30 days, without duplicates). File → File History… lists the versions, shows a diff against the current text, and restores one.

## 0.3.0 - 2026-10-23

### Changed

- Renamed the app to Calmpage (`Calmpage.app`, bundle ID `me.noguchy.calmpage`, repository `nogu66/calmpage`, Homebrew cask `calmpage`). Settings from Sumitex or Sumi are carried over on first launch, and the install script removes the old app.

### Added

- Show or hide the PDF preview with ⇧⌘P or the panel button at the right of the title bar. The editor takes the full width while it is hidden, and ⌘J opens it again.
- A panel button at the left of the title bar shows or hides the file list (also ⌘B).

## 0.2.0 - 2026-10-21

### Changed

- Renamed the app to Sumitex (`Sumitex.app`, bundle ID `me.noguchy.sumitex`). Settings from Sumi are carried over on first launch, and the install script removes the old `Sumi.app`.

## 0.1.0 - 2026-10-21

### Added

- Editor and live PDF preview in one window, compiled with your own `latexmk`
- Auto compile, error reporting in the editor and a Problems list
- SyncTeX in both directions
- Root document detection with `% !TEX root`, `.latexmkrc`, and automatic engine selection
- Reload and recompile on external file changes
- Light, dark, and system appearance with Paper, Moss, and Sand palettes
- English and Japanese interface
- Optional AI panel: ACP agents in a thread view (Claude Code and Codex built in), a built-in Terminal with your login shell, terminal agents, the ACP registry, and context chips
- Settings to manage agents or turn the AI panel off
