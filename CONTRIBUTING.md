# Contributing to Calmpage

Thank you for helping. Bug reports, ideas, translations, and pull requests are all welcome.

- **Found a bug?** [Open an issue](https://github.com/nogu66/calmpage/issues/new/choose) with the steps to reproduce it, your macOS version, and your TeX distribution.
- **Have an idea?** Open a feature request first, so we can agree on the shape before you write code. Calmpage aims to stay small and quiet, so new features are weighed carefully.
- **Found a security problem?** Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need macOS, [Node.js](https://nodejs.org) 22 or later, and a TeX distribution with `latexmk` and `synctex` (for example [MacTeX](https://www.tug.org/mactex/)).

```bash
git clone https://github.com/nogu66/calmpage.git
cd calmpage
npm install
npm run dev        # run with hot reload
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm run typecheck` | Type-check everything |
| `npm run build` | Build into `out/` |
| `npm start` | Run the built app |
| `npm run dist` | Package `release/mac-arm64/Calmpage.app` |

## Testing

`scripts/smoke.mjs` launches the built app with Playwright and walks through the main flows: compiling, error reporting, SyncTeX in both directions, external edits, switching documents, settings, and the AI panel. The AI panel is tested with `scripts/fake-acp-agent.mjs` (a minimal ACP agent) and a plain shell, so no real agent or account is needed.

By default the test runs on a temporary copy of `examples/sample`:

```bash
npm run build
node scripts/smoke.mjs
```

To try another LaTeX folder, pass a **copy** of it (the test edits files), and optionally a folder for the screenshots:

```bash
node scripts/smoke.mjs /path/to/copy-of-a-latex-folder /path/to/screenshots
```

Every check prints `PASS` or `FAIL`. Please run it before opening a pull request that changes behavior, and add a check when you add a feature.

The test window opens without taking focus, so it won't steal your keystrokes while it runs.

## Screenshots

The images in `docs/images/` are made from `examples/sample` by a script, so they can be retaken after the interface changes:

```bash
npm run screenshots    # light and dark screenshots, and the typing GIF and MP4
```

The script copies the sample to a temporary folder, so the repository is not changed. It needs Google Chrome (for the window frame) and `ffmpeg`.

## Project layout

Calmpage is an [Electron](https://www.electronjs.org) app built with [electron-vite](https://electron-vite.org).

| Path | What it does |
| --- | --- |
| `src/main/index.ts` | App entry: window, menus, IPC, settings changes |
| `src/main/build.ts` | Runs `latexmk`, parses the log, and calls SyncTeX |
| `src/main/files.ts` | Lists project files and watches for external changes |
| `src/main/search.ts` | Searches and replaces across the project files without blocking the main process |
| `src/main/history.ts` | Keeps a version of each file on every save, in `userData/history/` |
| `src/main/settings.ts` | Reads and writes settings (only values you changed are stored) |
| `src/main/acp.ts` | Starts ACP agents and relays threads, permission requests, and file reads/writes |
| `src/main/terminals.ts` | Starts terminal agents with node-pty |
| `src/main/registry.ts` | Loads the ACP registry and turns it into addable agents |
| `src/main/shell-env.ts` | Reads the login shell environment, so the app works when opened from Finder |
| `src/preload/index.ts` | The bridge between the window and the main process |
| `src/shared/agents.ts` | Agent settings and the built-in agents |
| `src/shared/i18n.ts` | All UI text in English and Japanese |
| `src/shared/search.ts` | The search pattern, matches, and replacement shared by the main process and the window |
| `src/renderer/main.ts` | The window: wiring, status, problems, settings, AI panel |
| `src/renderer/editor.ts` | The CodeMirror 6 editor |
| `src/renderer/tabs.ts` | The editor tabs |
| `src/renderer/search.ts` | Find and replace in the folder (sidebar) |
| `src/renderer/history.ts` | The File History sheet |
| `src/renderer/diff.ts` | Line diffs for the File History sheet |
| `src/renderer/preview.ts` | The pdf.js viewer; renders visible pages before swapping, so recompiles don't flicker |
| `src/renderer/thread.ts` | The ACP thread view (replies, tool calls, diffs, permissions, plans) |
| `src/renderer/terminal.ts` | The terminal view (xterm.js), themed to match the palette |
| `src/renderer/style.css` | All styles; colors are CSS variables per palette and appearance |
| `scripts/icon.mjs` | Exports `build/icon.svg` to the app icon and social images |
| `scripts/screenshots.mjs` | Takes the README screenshots and GIF from `examples/sample` |
| `examples/sample/` | A short multi-file paper for trying Calmpage and for the screenshots |

## Adding a language

All UI text lives in `src/shared/i18n.ts`.

1. Add a dictionary for your language with every key from the English one (TypeScript will tell you if a key is missing).
2. Add the language code to `Lang`, `LANGS`, and `DICTS`.
3. Add a button to the Language setting in `src/renderer/index.html`.

## Updating the built-in agents

Claude Code and Codex are launched through `npx` at fixed versions listed in `DEFAULT_AGENTS` (`src/shared/agents.ts`). To update them, use the versions from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) and try a short prompt with each agent before opening a pull request.

## Releasing

1. Bump `version` in `package.json` and move the *Unreleased* notes in `CHANGELOG.md` under the new version.
2. Run `scripts/release.sh`. It builds the app, signs it ad hoc, and writes `release/Calmpage-<version>-arm64-mac.zip` and `.dmg`. It prints the SHA-256 of the zip.
3. Commit, tag `v<version>`, push, and create the GitHub release with both files: `gh release create v<version> release/Calmpage-<version>-arm64-mac.zip release/Calmpage-<version>-arm64.dmg`.
4. In [nogu66/homebrew-tap](https://github.com/nogu66/homebrew-tap), update `version` and `sha256` in `Casks/calmpage.rb`.

`install.sh` always installs the latest release, so it needs no change.

## Style

- TypeScript in strict mode. Run `npm run typecheck` before you push.
- Two-space indentation, single quotes, no semicolons. Match the code around your change.
- Keep the interface quiet: no new colors outside the palette variables, and no new buttons unless they earn their place.
- Every piece of UI text goes through `src/shared/i18n.ts`, in both English and Japanese. If you don't speak Japanese, add the English text and say so in the pull request; a maintainer will translate it.
- Comments explain *why*, not *what*. Many existing comments are in Japanese; new comments in English are welcome.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change.
3. Run `npm run typecheck` and the smoke test.
4. Describe what changed and why. Add a screenshot for visible changes.
5. Add a line to `CHANGELOG.md` under *Unreleased*.
