# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal reading tracker called **Bookshelf**. It's a fully static app — no build step, no server, no framework. It runs directly in the browser via GitHub Pages and syncs data by reading/writing `books.md` to the repo via the GitHub API.

## Running the app

Serve the folder locally (the read-only view fetches `books.md` over HTTP, so opening files via `file://` won't work):

```
python3 -m http.server 8765
```

There is no build, compile, or install step. `.claude/launch.json` defines this server for the preview pane.

## Architecture

**Single-page app pattern across four HTML files:**
- `index.html` — Currently Reading
- `to-read.html` — Bought & To Read Someday (two lists, one page)
- `archive.html` — Finished & Abandoned
- `book.html` — Individual book detail view

All four pages share one JS file (`js/app.js`) and one CSS file (`css/style.css`). The correct entry point is wired up per-page via an inline `<script>` at the bottom of each HTML file (e.g. `Bookshelf.initCurrentlyReading()`).

**`js/app.js` — single IIFE, no modules, no dependencies.** Sections within it (marked with comment banners) cover:
- Database: `parseMarkdown()` / `serializeMarkdown()` — the entire data layer. Books live in `books.md` as structured Markdown; the JS parses it into plain objects and writes it back.
- GitHub API layer: reads/writes `books.md` via the REST API using a user-supplied fine-grained PAT stored in `localStorage`. Errors carry `err.status`.
- State: `loadDB()` / `commitChange()`. The parsed shelf is cached in `sessionStorage` with its ETag, and every load revalidates with `If-None-Match` (a 304 reuses the cache), so edits made elsewhere always appear. A copy we've just saved is trusted for 60 seconds, because GitHub can briefly serve the previous version. `commitChange(message, fn)` applies `fn` to a copy of the shelf and only commits it in memory once GitHub accepts the write; on a 409 (stale sha) it refetches and retries once. All mutations (`addBook`, `moveBook`, `removeBook`) go through it, and their commit messages describe the change (e.g. "Move Moonbound to Currently reading").
- Rendering: each page's `init*` function passes a render function to `showPage(render)`; after a change, `rerenderPage()` redraws from the in-memory shelf instead of reloading. HTML is built as arrays of strings joined together, with every value passed through `escapeHtml()`.
- Dates: moving or adding a book stamps `started` (Currently reading), `finished` or `abandoned` as `YYYY-MM-DD`, unless the book already has one. The Finished tab groups books by finished year, with undated ones under "Earlier".
- Editing: the owner can edit title, author, cover and dates in a modal on the book page (`openEditModal` → `editBook`). An uploaded cover is resized to 600px wide in the browser and committed to `covers/` via the contents API (`uploadFile`). Pages takes about a minute to serve it, so `coverSrc()` shows the uploaded copy from `sessionStorage` meanwhile.
- UI: modal system (one at a time; Escape closes, Tab is trapped, focus returns to the opener), toast notifications, Open Library search (only the newest response is shown).

**Two modes.** Without a token (any visitor), `loadDB()` reads the public `books.md` served alongside the site, read-only. With a token, `initNav()` adds `body.is-owner`; editing controls are marked `data-owner-only` in the HTML (hidden by CSS otherwise) or only rendered when `isConfigured()` in JS. Settings (the gear) stays visible to everyone so the owner can connect on a new device.

**`books.md` is the database.** Its structure must be preserved exactly — sections are `## <list-key>`, books are `### <title>`, fields are `- key: value` lines. The five valid list keys are: `currently-reading`, `to-read-bought`, `to-read-someday`, `archive-finished`, `archive-abandoned`. Field serialization order: `id` (timestamp string), `author`, then optional `cover` and `isbn`, then any other `- key: value` fields added by hand (e.g. `notes`, `finished`), which are preserved on save. Keys must be `\w+`.

**Custom cover images** live in `covers/` and are referenced in `books.md` as a relative path, e.g. `- cover: covers/my-book.jpg`; Open Library URLs work too. Keep them about 600px wide (`sips --resampleWidth 600 -s formatOptions normal`; sips ignores numeric quality values). Cards crop every cover to 2:3 with `object-fit: cover`, so covers far from book-shaped lose their edges.

**No credentials in code.** GitHub username, repo name, and PAT are entered by the user in a settings modal and stored in `localStorage` under the key `bookshelf_github_config`. Never hardcode these.

**`window.Bookshelf` public API** — the IIFE exposes four init functions: `initCurrentlyReading`, `initToRead`, `initArchive`, `initBookDetail`. Each HTML file calls exactly one of these at the bottom. Adding a new page means adding a new init function and exposing it here.

## CSS conventions

Mobile-first: base styles are the phone layout, and `min-width` queries in `em` add to them (37.5em shows the nav links in place of the hamburger; 42.5em is the roomier desktop layout). Values come from `:root` tokens; larger type sizes are fluid `clamp()`s; alpha colours are 8-digit hex. Prefer extending existing class names over renaming them.

## Fonts

Self-hosted from `fonts/` via `@font-face` in `css/style.css`: Hearken (serif, headings/brand, `--font-serif`) and DefSans (body, `--font-sans`).
