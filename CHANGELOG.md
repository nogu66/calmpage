# Changelog

All notable changes to Calmpage are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Completion for commands (with snippets), environments with the matching `\end`, `\ref` labels and `\cite` keys from the whole project, file and image paths, and commands defined with `\newcommand`.
- An outline in the sidebar that follows `\input` and `\include`. Click a heading to jump to it.
- Quiet math highlighting, folding for environments and sections, and indentation inside environments. Enter after `\begin{…}` closes the environment.
- Spell check for English prose with the macOS spell checker, with suggestions on right-click or ⌃Space. It can be turned off in Settings.
- Word and character counts below the editor, for the file, the selection, or the whole document.
- Bold (⇧⌘B), italic (⌘I), and emphasis (⇧⌘I), and Undo, Redo, Find, Replace, Find Next, Go to Line, and Comment in the Edit menu.

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
