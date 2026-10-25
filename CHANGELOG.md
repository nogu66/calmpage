# Changelog

All notable changes to Calmpage are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Links in the PDF work: contents, `\ref`, `\cite`, and hyperref links scroll to their target, and URLs open in your browser. ⌘-click still jumps to the source.
- Select and copy text in the PDF.
- Find in the PDF with ⌥⌘F, or ⌘F while the PDF has focus. Matches are marked, and ⏎ / ⇧⏎ move between them.
- A quiet bar above the PDF shows the page (for example 3 / 12) and the zoom. Type a page number to go there, or turn pages with ← / →.
- Fit width, whole page, or two pages side by side, from the bar or **Settings → PDF**. The choice is remembered.
- **Settings → PDF → Dark pages in dark mode** inverts the PDF while the app is dark (off by default).
- Unsaved changes in every open file are written before you quit, close the window, or switch folders or files. If saving fails, or *Auto compile* is off, Calmpage asks Save / Don't Save / Cancel, and the close button shows a dot while anything is unsaved.
- File operations from the file list's context menu and the File menu: New File (⌘N), New Folder (⌥⌘N), Rename, Move to Trash, and Show in Finder. Names are typed right in the file list.
- The file list also shows images (PNG, JPEG, PDF, EPS, SVG) and other project files such as `.txt`, `.csv`, `.md`, `.bbx`, `.cbx`, `.dtx`, and `.ins`. Text files open in the editor, and images and PDFs open in Quick Look. Only changes to sources still trigger a recompile.
- Drop an image on the editor to copy it into the project (into `figures/` or an existing image folder) and insert a `figure` environment with `\includegraphics`, `\caption`, and `\label`. Drop files on the file list to copy them into a folder.
- New Document… (⇧⌘N) puts a template into an empty folder and opens it: paper (article), Japanese paper (ltjsarticle with LuaLaTeX, or jsarticle with upLaTeX), beamer slides, report, or letter. Papers and reports come with a `.bib` file.
- File → Open Recent lists recently opened folders. They also appear in macOS's recent items.

### Fixed

- upLaTeX documents failed to compile, because `latexmk` does not accept `-bibtex=upbibtex`. upbibtex is now set with `-e`.

### Changed

- New app icon: a half moon rising from the horizon on a sheet of paper, with its reflection drawn as lines of text.
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
