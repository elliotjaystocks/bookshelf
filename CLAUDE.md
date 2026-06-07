# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal reading tracker called **Bookshelf**. It's a fully static app — no build step, no server, no framework. It runs directly in the browser via GitHub Pages and syncs data by reading/writing `books.md` to the repo via the GitHub API.

## Running the app

Open any `.html` file directly in a browser, or serve it locally:

```
npx serve .
```

There is no build, compile, or install step.

## Architecture

**Single-page app pattern across four HTML files:**
- `index.html` — Currently Reading
- `to-read.html` — Bought & To Read Someday (two lists, one page)
- `archive.html` — Finished & Abandoned
- `book.html` — Individual book detail view

All four pages share one JS file (`js/app.js`) and one CSS file (`css/style.css`). The correct entry point is wired up per-page via an inline `<script>` at the bottom of each HTML file (e.g. `Bookshelf.initCurrentlyReading()`).

**`js/app.js` — single IIFE, no modules, no dependencies.** Sections within it (marked with comment banners) cover:
- Database: `parseMarkdown()` / `serializeMarkdown()` — the entire data layer. Books live in `books.md` as structured Markdown; the JS parses it into plain objects and writes it back.
- GitHub API layer: reads/writes `books.md` via the REST API using a user-supplied fine-grained PAT stored in `localStorage`.
- Session cache: raw Markdown cached in `sessionStorage` to avoid redundant API calls.
- UI: modal system, toast notifications, drag-and-drop reordering, Open Library cover/ISBN search.

**`books.md` is the database.** Its structure must be preserved exactly — sections are `## <list-key>`, books are `### <title>`, fields are `- key: value` lines. The five valid list keys are: `currently-reading`, `to-read-bought`, `to-read-someday`, `archive-finished`, `archive-abandoned`.

**Custom cover images** can be placed in the `covers/` directory and referenced in `books.md` as a relative path, e.g. `- cover: covers/my-book.jpg`. The app renders whatever URL or path is in the `cover:` field, so both Open Library URLs and local paths work interchangeably.

**No credentials in code.** GitHub username, repo name, and PAT are entered by the user in a settings modal and stored in `localStorage` under the key `bookshelf_github_config`. Never hardcode these.

## Fonts

Fraunces (headings/brand) and IBM Plex Sans (body) loaded from Google Fonts.
