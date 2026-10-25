# Changelog

All notable changes to Calmpage are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## 0.4.0 - 2026-10-25

### Added

- Links in the PDF work: contents, `\ref`, `\cite`, and hyperref links scroll to their target, and URLs open in your browser. ⌘-click still jumps to the source.
- Select and copy text in the PDF.
- Find in the PDF with ⌥⇧⌘F, or ⌘F while the PDF has focus. Matches are marked, and ⏎ / ⇧⏎ move between them.
- A quiet bar above the PDF shows the page (for example 3 / 12) and the zoom. Type a page number to go there, or turn pages with ← / →.
- Fit width, whole page, or two pages side by side, from the bar or **Settings → PDF**. The choice is remembered.
- **Settings → PDF → Dark pages in dark mode** inverts the PDF while the app is dark (off by default).
- Unsaved changes in every open file are written before you quit, close the window, or switch folders or files. If saving fails, or *Auto compile* is off, Calmpage asks Save / Don't Save / Cancel, and the close button shows a dot while anything is unsaved.
- File operations from the file list's context menu and the File menu: New File (⌘N), New Folder (⌥⌘N), Rename, Move to Trash, and Show in Finder. Names are typed right in the file list.
- The file list also shows images (PNG, JPEG, PDF, EPS, SVG) and other project files such as `.txt`, `.csv`, `.md`, `.bbx`, `.cbx`, `.dtx`, and `.ins`. Text files open in the editor, and images and PDFs open in Quick Look. Only changes to sources still trigger a recompile.
- Drop an image on the editor to copy it into the project (into `figures/` or an existing image folder) and insert a `figure` environment with `\includegraphics`, `\caption`, and `\label`. Drop files on the file list to copy them into a folder.
- New Document… (⇧⌘N) puts a template into an empty folder and opens it: paper (article), Japanese paper (ltjsarticle with LuaLaTeX, or jsarticle with upLaTeX), beamer slides, report, or letter. Papers and reports come with a `.bib` file.
- File → Open Recent lists recently opened folders. They also appear in macOS's recent items.
- Find and replace across the folder in the sidebar (⇧⌘F, or Edit → Find in Folder), with match case, whole word, and regular expressions. Results are grouped by file; Replace All asks first, changes open files in the editor, and writes the others to disk.
- Editor tabs for the files you open. A dot marks unsaved changes and an underline marks the root document. Close a tab with ×, ⌘W, or a middle click (unsaved changes are saved first), and move between tabs with ⌃Tab / ⌃⇧Tab or ⇧⌘[ / ⇧⌘]. The tabs come back the next time you open the folder.
- Local file history: every save keeps a version of the file in `~/Library/Application Support/Calmpage/history/` (up to 50 per file, for 30 days, without duplicates). File → File History… lists the versions, shows a diff against the current text, and restores one.
- Saving a `.bib`, `.sty`, or `.cls` file recompiles the document that uses it (found from latexmk’s records, `\bibliography` / `\addbibresource` / `\usepackage`, or the current root).
- Stop a compile with File → Stop Compiling (⌘.) or *Stop* next to the status. The whole `latexmk` process group is stopped and pending compiles are dropped.
- File → Remove Auxiliary Files runs `latexmk -c` with the same options as a compile, keeping the PDF and SyncTeX data.
- `% !TEX program = …` and `% !TEX TS-program = …` choose the engine (pdfLaTeX, XeLaTeX, LuaLaTeX, upLaTeX, pLaTeX), ahead of `.latexmkrc`. A *Default engine* setting is used when neither is present.
- An *Allow shell escape* setting (off by default) passes `-shell-escape` to `latexmk`.
- A *Log* view next to the Problems list shows the `.log` and the `latexmk` output from the end, with search.
- BibTeX and Biber warnings and errors appear in the Problems list, linked to the line in the `.bib` file.
- Completion for commands (with snippets), environments with the matching `\end`, `\ref` labels and `\cite` keys from the whole project, file and image paths, and commands defined with `\newcommand`.
- An outline in the sidebar that follows `\input` and `\include`. Click a heading to jump to it.
- Quiet math highlighting, folding for environments and sections, and indentation inside environments. Enter after `\begin{…}` closes the environment.
- Spell check for English prose with the macOS spell checker, with suggestions on right-click or ⌃Space. It can be turned off in Settings.
- Word and character counts below the editor, for the file, the selection, or the whole document.
- Bold (⇧⌘B), italic (⌘I), and emphasis (⇧⌘I), and Undo, Redo, Find, Replace, Find Next, Go to Line, and Comment in the Edit menu.
- Open several windows at once with File → New Window (⌃⌘N), each with its own folder, compiles, file watching, and agents. Opening a folder that is already open brings its window to the front; folders opened from Finder or the Dock go to the front window if it is empty, or to a new window. Closing a window asks only about that window's unsaved changes, ⌘Q asks window by window, and the open windows (folder, files, tabs, and position) are restored at the next launch. Close a window with ⇧⌘W.
- Pick an ACP agent from a searchable list: **+ → Add agent…** in the AI panel, or **Settings → Agents**. The list has two tabs, *Ready to use* and *Needs installing*; a search that finds nothing in the current tab switches to the tab that has matches. Each agent shows its icon, a short description, and whether it is ready to add, can be installed, is already added, or can't run on this Mac (and why). Use ↑ / ↓, ⏎, and Esc. Picking from the panel adds the agent and opens it in a new tab right away. The registry is read in advance when the panel opens; if it can't be read, the list says so and offers *Try again*.
- Agents distributed as their own program (such as goose, Kimi CLI, or Amp) can be installed from the list. Calmpage downloads the archive into `~/Library/Application Support/Calmpage/agents/`, checks its SHA-256 when the registry lists one, unpacks it, and adds it. Progress shows in the row. Older versions are removed when a new one is installed, and the files are removed when you remove the agent.

### Fixed

- upLaTeX documents failed to compile, because `latexmk` does not accept `-bibtex=upbibtex`. upbibtex is now set with `-e`.
- Warnings from files read with `\input` (such as undefined references) pointed at the root document instead of the file that caused them.
- In a long file list, names scrolled underneath the settings button at the bottom left. The list now ends above the button.

### Changed

- In **Settings → Agents**, the fields for typing a command yourself are folded behind *Add with your own command…*. They still open when you click an agent to edit it.
- When an ACP agent fails to start, the message includes the detail the agent sent (for example goose's "Configuration value not found: GOOSE_PROVIDER"), not only "Internal error".
- New app icon: a half moon rising from the horizon on a sheet of paper, with its reflection drawn as lines of text.

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
