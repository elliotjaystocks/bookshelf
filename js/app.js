/* =============================================================
   BOOKSHELF — app.js
   Single-file bundle. No ES modules, no build step required.
   Works on localhost and GitHub Pages. Visitors get a read-only
   view of books.md; connecting a GitHub token unlocks editing.
   ============================================================= */

(function () {
  'use strict';

  // =============================================================
  // CONSTANTS
  // =============================================================

  var LISTS = {
    'currently-reading': 'Currently reading',
    'to-read-bought':    'Bought & ready to read',
    'to-read-someday':   'Want to read someday',
    'archive-finished':  'Finished',
    'archive-abandoned': 'Abandoned',
  };

  var LIST_PAGE = {
    'currently-reading': 'index.html',
    'to-read-bought':    'to-read.html',
    'to-read-someday':   'to-read.html',
    'archive-finished':  'archive.html',
    'archive-abandoned': 'archive.html',
  };

  var CONFIG_KEY  = 'bookshelf_github_config';
  var SESSION_KEY = 'bookshelf_session';
  var FILE_PATH   = 'books.md';

  // =============================================================
  // DATABASE  —  Markdown ↔ JS objects
  // =============================================================

  function createEmptyDB() {
    var db = {};
    Object.keys(LISTS).forEach(function (k) { db[k] = []; });
    return db;
  }

  function parseMarkdown(md) {
    var db = createEmptyDB();
    if (!md || !md.trim()) return db;

    var parts = md.split(/^## /m);

    parts.slice(1).forEach(function (part) {
      var lines   = part.split('\n');
      var section = lines[0].trim();
      if (!Object.prototype.hasOwnProperty.call(db, section)) return;

      var body      = lines.slice(1).join('\n');
      var bookParts = body.split(/^### /m).slice(1);

      bookParts.forEach(function (bookPart) {
        var bookLines = bookPart.split('\n');
        var title     = bookLines[0].trim();
        if (!title) return;

        var book = { title: title };
        bookLines.slice(1).forEach(function (line) {
          var match = line.match(/^- (\w+): (.+)$/);
          if (match) book[match[1]] = match[2].trim();
        });
        db[section].push(book);
      });
    });

    return db;
  }

  var CORE_FIELDS = ['title', 'id', 'author', 'cover', 'isbn'];

  function serializeMarkdown(db) {
    var md = '# Bookshelf\n';
    Object.keys(db).forEach(function (section) {
      md += '\n## ' + section + '\n';
      db[section].forEach(function (book) {
        md += '\n### ' + book.title + '\n';
        md += '- id: '     + book.id     + '\n';
        md += '- author: ' + (book.author || 'Unknown') + '\n';
        if (book.cover) md += '- cover: ' + book.cover + '\n';
        if (book.isbn)  md += '- isbn: '  + book.isbn  + '\n';

        // Keep any extra fields added to books.md by hand (notes, dates, etc.)
        Object.keys(book).forEach(function (key) {
          if (CORE_FIELDS.indexOf(key) !== -1 || !book[key]) return;
          md += '- ' + key + ': ' + book[key] + '\n';
        });
      });
    });
    return md + '\n';
  }

  function createBook(data) {
    return {
      id:     String(Date.now()),
      title:  (data.title  || 'Unknown Title').trim(),
      author: (data.author || 'Unknown Author').trim(),
      cover:  data.cover || '',
      isbn:   data.isbn  || '',
    };
  }

  // =============================================================
  // GITHUB API
  // =============================================================

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
    } catch (e) {
      return null;
    }
  }

  function saveConfig(config) {
    if (config === null) {
      localStorage.removeItem(CONFIG_KEY);
    } else {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    }
  }

  function isConfigured() {
    var c = getConfig();
    return !!(c && c.username && c.repo && c.token);
  }

  function encodeContent(str) {
    var bytes  = new TextEncoder().encode(str);
    var binary = Array.from(bytes, function (b) { return String.fromCodePoint(b); }).join('');
    return btoa(binary);
  }

  function decodeContent(b64) {
    var binary = atob(b64.replace(/\n/g, ''));
    var bytes  = Uint8Array.from(binary, function (c) { return c.codePointAt(0); });
    return new TextDecoder().decode(bytes);
  }

  // Resolves to { data, etag }, or { notModified: true } when an If-None-Match
  // request gets a 304. Errors carry the HTTP status as err.status.
  function apiRequest(path, method, body, extraHeaders) {
    var config = getConfig();
    if (!config) return Promise.reject(new Error('GitHub is not configured.'));

    var url = 'https://api.github.com/repos/' + config.username + '/' + config.repo + '/contents/' + path;
    var headers = Object.assign({
      'Authorization':        'Bearer ' + config.token,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, extraHeaders || {});

    // Bypass the browser's HTTP cache, which otherwise serves GitHub
    // responses for up to 60 seconds and hides fresh changes
    var options = { method: method || 'GET', headers: headers, cache: 'no-store' };

    if (body) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    return fetch(url, options).then(function (response) {
      if (response.status === 304) return { notModified: true };
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (err) {
          var error = new Error(err.message || ('GitHub API error ' + response.status));
          error.status = response.status;
          throw error;
        });
      }
      var etag = response.headers.get('ETag');
      return response.json().then(function (data) { return { data: data, etag: etag }; });
    });
  }

  // Pass the ETag from a previous read to get { notModified: true } back
  // when books.md hasn't changed. 304s don't count against the rate limit.
  function readFile(etag) {
    var headers = etag ? { 'If-None-Match': etag } : null;
    return apiRequest(FILE_PATH, 'GET', null, headers).then(function (res) {
      if (res.notModified) return res;
      return { content: decodeContent(res.data.content), sha: res.data.sha, etag: res.etag };
    }).catch(function (err) {
      if (err.status === 404) return { content: null, sha: null, etag: null };
      throw err;
    });
  }

  function writeFile(content, sha, message) {
    var body = {
      message: message || 'Update bookshelf',
      content: encodeContent(content),
    };
    if (sha) body.sha = sha;
    return apiRequest(FILE_PATH, 'PUT', body).then(function (res) { return res.data; });
  }

  // Read-only path for visitors: the copy of books.md served alongside the
  // site. No token needed; it trails the repo by however long Pages takes to deploy.
  function readPublicFile() {
    return fetch(FILE_PATH, { cache: 'no-cache' }).then(function (response) {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Could not load ' + FILE_PATH + ' (' + response.status + ')');
      return response.text();
    });
  }

  function validateConfig(username, repo, token) {
    var url = 'https://api.github.com/repos/' + username + '/' + repo;
    return fetch(url, {
      headers: {
        'Authorization':        'Bearer ' + token,
        'Accept':               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (err) {
          throw new Error(err.message || ('Could not reach repository (' + response.status + ')'));
        });
      }
      return response.json();
    });
  }

  // =============================================================
  // OPEN LIBRARY SEARCH
  // =============================================================

  function coverFromId(coverId, size) {
    if (!coverId) return null;
    return 'https://covers.openlibrary.org/b/id/' + coverId + '-' + (size || 'M') + '.jpg';
  }

  function searchBooks(query) {
    var params = new URLSearchParams({
      q:      query.trim(),
      fields: 'key,title,author_name,isbn,cover_i,first_publish_year',
      limit:  '20',
    });

    return fetch('https://openlibrary.org/search.json?' + params).then(function (response) {
      if (!response.ok) throw new Error('Open Library search failed (' + response.status + ')');
      return response.json();
    }).then(function (data) {
      return (data.docs || []).map(function (doc) {
        var isbn  = (doc.isbn || [])[0] || '';
        var cover = doc.cover_i ? coverFromId(doc.cover_i) : (isbn ? 'https://covers.openlibrary.org/b/isbn/' + isbn + '-M.jpg' : null);
        return {
          title:  doc.title || 'Unknown Title',
          author: (doc.author_name || [])[0] || 'Unknown Author',
          isbn:   isbn,
          cover:  cover,
          year:   doc.first_publish_year || '',
        };
      });
    });
  }

  // =============================================================
  // STATE  —  DB loading, saving, mutations
  // =============================================================

  var _db   = null;
  var _sha  = null;
  var _etag = null;

  // Right after a save, GitHub can briefly serve the previous version of the
  // file, so a copy we've just written is trusted for this long without asking.
  var JUST_SAVED_MS = 60 * 1000;

  function readCache() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeCache(savedAt) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        db: _db, sha: _sha, etag: _etag, savedAt: savedAt || 0,
      }));
    } catch (e) { /* sessionStorage unavailable */ }
  }

  function useCache(cached) {
    _db   = cached.db;
    _sha  = cached.sha;
    _etag = cached.etag;
    return _db;
  }

  function applyFile(result) {
    _sha  = result.sha;
    _etag = result.etag;
    _db   = result.content ? parseMarkdown(result.content) : createEmptyDB();
    writeCache();
    return _db;
  }

  // The cache is only a shortcut: every load asks GitHub whether books.md has
  // changed (a cheap 304 when it hasn't), so edits made elsewhere always show up.
  function loadDB() {
    if (!isConfigured()) {
      return readPublicFile().then(function (md) {
        _db = md ? parseMarkdown(md) : createEmptyDB();
        return _db;
      });
    }

    var cached = readCache();
    if (cached && cached.savedAt && Date.now() - cached.savedAt < JUST_SAVED_MS) {
      return Promise.resolve(useCache(cached));
    }

    return readFile(cached && cached.etag).then(function (result) {
      return result.notModified ? useCache(cached) : applyFile(result);
    }).catch(function (err) {
      // Offline or GitHub unreachable (no HTTP status): fall back to the cache
      if (cached && !err.status) return useCache(cached);
      throw err;
    });
  }

  function initDB() {
    return readFile(null).then(function (result) {
      if (result.content !== null) return applyFile(result);
      _db = createEmptyDB();
      return writeFile(serializeMarkdown(_db), null, 'Create books.md').then(function (data) {
        _sha  = data.content.sha;
        _etag = null;
        writeCache(Date.now());
      });
    });
  }

  // Applies `change` to a copy of the shelf and saves it, only touching the
  // in-memory shelf once GitHub accepts. If books.md changed elsewhere since we
  // loaded it (say, on another device), GitHub rejects the stale sha with a 409,
  // so we fetch the latest version, reapply the change and try once more.
  function commitChange(message, change, isRetry) {
    if (!_db) return Promise.reject(new Error('Database not loaded'));
    var next = JSON.parse(JSON.stringify(_db));

    return Promise.resolve().then(function () {
      return change(next);
    }).then(function (result) {
      return writeFile(serializeMarkdown(next), _sha, message).then(function (data) {
        _db   = next;
        _sha  = data.content.sha;
        _etag = null;
        writeCache(Date.now());
        return result;
      });
    }).catch(function (err) {
      if (err.status !== 409 || isRetry) throw err;
      return readFile(null).then(applyFile).then(function () {
        return commitChange(message, change, true);
      });
    });
  }

  function takeBook(db, bookId, listId) {
    var idx = db[listId].findIndex(function (b) { return b.id === bookId; });
    if (idx === -1) throw new Error('Book not found');
    return db[listId].splice(idx, 1)[0];
  }

  function bookTitle(bookId, listId) {
    var book = (_db && _db[listId] || []).find(function (b) { return b.id === bookId; });
    return book ? book.title : 'book';
  }

  function addBook(bookData, listId) {
    var book = createBook(bookData);
    stampDate(book, listId);
    return commitChange('Add ' + book.title + ' to ' + LISTS[listId], function (db) {
      db[listId].push(book);
      return book;
    });
  }

  function removeBook(bookId, listId) {
    var message = 'Remove ' + bookTitle(bookId, listId) + ' from ' + LISTS[listId];
    return commitChange(message, function (db) {
      takeBook(db, bookId, listId);
    });
  }

  function moveBook(bookId, fromList, toList) {
    var message = 'Move ' + bookTitle(bookId, fromList) + ' to ' + LISTS[toList];
    return commitChange(message, function (db) {
      var book = takeBook(db, bookId, fromList);
      stampDate(book, toList);
      db[toList].push(book);
      return book;
    });
  }

  // Empty values remove optional fields (e.g. clearing a date); title and author always stay
  function editBook(bookId, listId, fields) {
    return commitChange('Edit ' + bookTitle(bookId, listId), function (db) {
      var book = db[listId].find(function (b) { return b.id === bookId; });
      if (!book) throw new Error('Book not found');
      Object.keys(fields).forEach(function (key) {
        if (fields[key]) book[key] = fields[key];
        else if (key !== 'title' && key !== 'author') delete book[key];
      });
      return book;
    });
  }

  // Saves an image (base64) to the repo, replacing any file already at `path`
  function uploadFile(path, base64, message) {
    return apiRequest(path, 'GET').then(function (res) {
      return res.data.sha;
    }).catch(function (err) {
      if (err.status === 404) return null;
      throw err;
    }).then(function (sha) {
      var body = { message: message, content: base64 };
      if (sha) body.sha = sha;
      return apiRequest(path, 'PUT', body);
    });
  }

  // =============================================================
  // SVG ICONS
  // =============================================================

  var ICON_X = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  var ICON_SEARCH_INLINE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

  var ICON_SEARCH_NAV = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';

  var ICON_SETTINGS_NAV = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>';

  var ICON_PLUS = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>';

  var ICON_ARROW_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 19-7-7 7-7M5 12h14"/></svg>';

  var ICON_CHEVRON_MD = '<svg class="search-result-chevron" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

  var ICON_BOOK_OPEN = '<svg class="empty-state-icon" xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';

  // =============================================================
  // UTILITIES
  // =============================================================

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showToast(message, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast ' + (type || '');
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity   = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(function () { toast.remove(); }, 320);
    }, 3200);
  }

  function hideLoading() {
    var el = document.getElementById('page-loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(function () { el.hidden = true; }, 320);
  }

  // =============================================================
  // MODAL SYSTEM
  // =============================================================

  var _activeOverlay = null;
  var _returnFocus   = null;

  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

  // Escape closes; Tab and Shift+Tab stay inside the modal
  function onModalKeydown(e) {
    if (!_activeOverlay) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key !== 'Tab') return;

    var focusable = Array.prototype.filter.call(
      _activeOverlay.querySelectorAll(FOCUSABLE),
      function (el) { return el.offsetParent !== null; }
    );
    if (!focusable.length) return;

    var first = focusable[0];
    var last  = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function closeModal() {
    if (!_activeOverlay) return;
    var overlay = _activeOverlay;
    _activeOverlay = null;
    document.removeEventListener('keydown', onModalKeydown);
    overlay.classList.remove('open');
    setTimeout(function () { overlay.remove(); }, 220);

    if (_returnFocus && document.contains(_returnFocus)) _returnFocus.focus();
    _returnFocus = null;
  }

  // Each modal's heading should have id="modal-title" (there's only ever one open)
  function createOverlay() {
    if (_activeOverlay) closeModal();

    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'modal-title');

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });

    _returnFocus = document.activeElement;
    document.addEventListener('keydown', onModalKeydown);

    document.getElementById('modal-root').appendChild(overlay);
    _activeOverlay = overlay;

    // Two rAF calls ensure the transition fires after paint
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add('open');
        if (!overlay.contains(document.activeElement)) {
          var target = overlay.querySelector('input:not([type="file"])') || overlay.querySelector(FOCUSABLE);
          if (target) target.focus();
        }
      });
    });

    return overlay;
  }

  // =============================================================
  // SEARCH MODAL
  // =============================================================

  function openSearchModal(defaultList) {
    defaultList = defaultList || 'currently-reading';
    var overlay = createOverlay();

    overlay.innerHTML = [
      '<div class="modal">',
        '<div class="modal-header">',
          '<h2 class="modal-title" id="modal-title">Find a book</h2>',
          '<button class="modal-close" aria-label="Close">' + ICON_X + '</button>',
        '</div>',
        '<div class="modal-body" id="modal-body"></div>',
        '<div class="modal-footer" id="modal-footer"></div>',
      '</div>',
    ].join('');

    overlay.querySelector('.modal-close').addEventListener('click', closeModal);
    showSearchView(overlay, defaultList);
  }

  function showSearchView(overlay, defaultList) {
    overlay.querySelector('#modal-title').textContent = 'Find a book';
    overlay.querySelector('#modal-footer').innerHTML  = '';

    overlay.querySelector('#modal-body').innerHTML = [
      '<div class="search-input-wrap">',
        ICON_SEARCH_INLINE,
        '<input type="search" id="search-query" class="search-input"',
          ' placeholder="Title, author, or ISBN…" autocomplete="off" aria-label="Search for books">',
      '</div>',
      '<div id="search-results" class="search-results">',
        '<p class="search-status">Start typing to search the Open Library catalogue…</p>',
      '</div>',
    ].join('');

    var input    = overlay.querySelector('#search-query');
    var results  = overlay.querySelector('#search-results');
    var debounce = null;
    var latest   = 0;  // only the newest search may update the results

    input.addEventListener('input', function () {
      clearTimeout(debounce);
      var seq = ++latest;
      var q   = input.value.trim();
      if (q.length < 2) {
        results.innerHTML = '<p class="search-status">Start typing to search the Open Library catalogue…</p>';
        return;
      }
      results.innerHTML = '<div class="search-status"><div class="spinner"></div></div>';

      debounce = setTimeout(function () {
        searchBooks(q).then(function (books) {
          if (seq !== latest) return;
          if (!books.length) {
            results.innerHTML = '<p class="search-status">No results found. Try a different search.</p>';
            return;
          }
          results.innerHTML = books.map(function (b, i) {
            return [
              '<button type="button" class="search-result" data-index="' + i + '">',
                '<span class="search-result-cover">',
                  b.cover ? '<img src="' + escapeHtml(b.cover) + '" alt="" loading="lazy">' : '',
                '</span>',
                '<span class="search-result-info">',
                  '<span class="search-result-title">' + escapeHtml(b.title) + '</span>',
                  '<span class="search-result-meta">' + escapeHtml(b.author) + (b.year ? ' · ' + b.year : '') + '</span>',
                '</span>',
                ICON_CHEVRON_MD,
              '</button>',
            ].join('');
          }).join('');

          results.querySelectorAll('.search-result').forEach(function (el) {
            el.addEventListener('click', function () {
              showPreviewView(overlay, books[parseInt(el.dataset.index, 10)], defaultList);
            });
          });

        }).catch(function () {
          if (seq !== latest) return;
          results.innerHTML = '<p class="search-status">Search failed. Check your connection and try again.</p>';
        });
      }, 420);
    });

    requestAnimationFrame(function () { input.focus(); });
  }

  function showPreviewView(overlay, bookData, defaultList) {
    overlay.querySelector('#modal-title').textContent = 'Add to your shelf';

    overlay.querySelector('#modal-body').innerHTML = [
      '<div class="preview-book">',
        '<div class="preview-cover">',
          bookData.cover
            ? '<img src="' + escapeHtml(bookData.cover) + '" alt="">'
            : '<div class="preview-cover-placeholder"><span>' + escapeHtml(bookData.title) + '</span></div>',
        '</div>',
        '<div class="preview-info">',
          '<p class="preview-title">' + escapeHtml(bookData.title) + '</p>',
          '<p class="preview-author">' + escapeHtml(bookData.author) + '</p>',
        '</div>',
      '</div>',
      '<fieldset class="list-options">',
        '<legend class="list-options-label">Add to…</legend>',
        Object.keys(LISTS).map(function (id) {
          return [
            '<label class="list-option">',
              '<input type="radio" name="target-list" value="' + id + '"' + (id === defaultList ? ' checked' : '') + '>',
              '<span class="list-option-name">' + escapeHtml(LISTS[id]) + '</span>',
            '</label>',
          ].join('');
        }).join(''),
      '</fieldset>',
    ].join('');

    overlay.querySelector('#modal-footer').innerHTML = [
      '<button class="btn btn-ghost" id="btn-back">' + ICON_ARROW_LEFT + ' Back to results</button>',
      '<button class="btn btn-primary" id="btn-add-confirm">Add book</button>',
    ].join('');

    overlay.querySelector('#btn-back').addEventListener('click', function () {
      showSearchView(overlay, defaultList);
    });

    var checked = overlay.querySelector('input[name="target-list"]:checked');
    if (checked) checked.focus();

    overlay.querySelector('#btn-add-confirm').addEventListener('click', function () {
      var selected = overlay.querySelector('input[name="target-list"]:checked');
      if (!selected) return;

      var btn = overlay.querySelector('#btn-add-confirm');
      btn.disabled    = true;
      btn.textContent = 'Saving…';

      addBook(bookData, selected.value).then(function () {
        closeModal();
        showToast('Added to ' + LISTS[selected.value] + '.', 'success');
        rerenderPage();
      }).catch(function (err) {
        console.error(err);
        btn.disabled    = false;
        btn.textContent = 'Add book';
        showToast('Could not save. Check your settings.', 'error');
      });
    });
  }

  // =============================================================
  // SETTINGS MODAL
  // =============================================================

  function openSettingsModal() {
    var overlay = createOverlay();
    var config  = getConfig() || {};

    overlay.innerHTML = [
      '<div class="modal">',
        '<div class="modal-header">',
          '<h2 class="modal-title" id="modal-title">Connect to GitHub</h2>',
          '<button class="modal-close" aria-label="Close">' + ICON_X + '</button>',
        '</div>',
        '<div class="modal-body">',
          '<p class="settings-intro">',
            'Elliot’s bookshelf saves your reading list to a <code>books.md</code> file in a GitHub ',
            'repository of your choice. You’ll need a personal access token so the app ',
            'can read and write that file on your behalf.<br><br>',
            '<strong>To create a token:</strong> go to ',
            '<a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener">',
              'GitHub → Settings → Developer settings → Fine-grained tokens',
            '</a>, ',
            'click <em>Generate new token</em>, select your bookshelf repo under ',
            '<em>Repository access</em>, and grant ',
            '<strong>Contents → Read and write</strong> permission.',
          '</p>',
          '<div class="field">',
            '<label for="cfg-username">GitHub username</label>',
            '<input',
              ' type="text"',
              ' id="cfg-username"',
              ' value="' + escapeHtml(config.username || '') + '"',
              ' placeholder="your-username"',
              ' autocomplete="off"',
              ' spellcheck="false">',
          '</div>',
          '<div class="field">',
            '<label for="cfg-repo">Repository name</label>',
            '<input',
              ' type="text"',
              ' id="cfg-repo"',
              ' value="' + escapeHtml(config.repo || '') + '"',
              ' placeholder="bookshelf"',
              ' autocomplete="off"',
              ' spellcheck="false">',
            '<p class="field-note">The repository where <code>books.md</code> will live.</p>',
          '</div>',
          '<div class="field">',
            '<label for="cfg-token">Personal access token</label>',
            '<input',
              ' type="password"',
              ' id="cfg-token"',
              ' value="' + escapeHtml(config.token || '') + '"',
              ' placeholder="github_pat_…"',
              ' autocomplete="off"',
              ' spellcheck="false">',
            '<p class="field-note">Stored only in your browser’s local storage. Never shared with anyone.</p>',
          '</div>',
          '<div id="settings-feedback"></div>',
        '</div>',
        '<div class="modal-footer">',
          '<button class="btn btn-secondary" id="btn-settings-cancel">Cancel</button>',
          '<button class="btn btn-primary" id="btn-settings-save">Save &amp; connect</button>',
        '</div>',
      '</div>',
    ].join('');

    overlay.querySelector('.modal-close').addEventListener('click', closeModal);
    overlay.querySelector('#btn-settings-cancel').addEventListener('click', closeModal);

    overlay.querySelector('#btn-settings-save').addEventListener('click', function () {
      var username = overlay.querySelector('#cfg-username').value.trim();
      var repo     = overlay.querySelector('#cfg-repo').value.trim();
      var token    = overlay.querySelector('#cfg-token').value.trim();
      var feedback = overlay.querySelector('#settings-feedback');

      if (!username || !repo || !token) {
        feedback.innerHTML = '<p class="settings-error">Please fill in all three fields.</p>';
        return;
      }

      var btn = overlay.querySelector('#btn-settings-save');
      btn.disabled    = true;
      btn.textContent = 'Connecting…';
      feedback.innerHTML = '';

      // Validate credentials first, then save
      validateConfig(username, repo, token).then(function () {
        saveConfig({ username: username, repo: repo, token: token });
        return initDB();
      }).then(function () {
        closeModal();
        showToast('Connected! Loading your books…', 'success');
        setTimeout(function () { location.reload(); }, 500);
      }).catch(function (err) {
        console.error(err);
        btn.disabled    = false;
        btn.textContent = 'Save & connect';
        feedback.innerHTML = '<p class="settings-error">' +
          escapeHtml(err.message) + '<br>' +
          'Check your username, repository name, and token, then try again.</p>';
      });
    });
  }

  // =============================================================
  // DATES  —  started / finished / abandoned, stored as YYYY-MM-DD
  // =============================================================

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // The date field stamped when a book arrives on each shelf
  var DATE_FIELD_FOR_LIST = {
    'currently-reading': 'started',
    'archive-finished':  'finished',
    'archive-abandoned': 'abandoned',
  };

  function pad(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // Today in the reader's own time zone
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isIsoDate(str) {
    return /^\d{4}-\d{2}-\d{2}$/.test(str || '');
  }

  // Keeps an existing date, so moving a book back and forth doesn't overwrite it
  function stampDate(book, listId) {
    var field = DATE_FIELD_FOR_LIST[listId];
    if (field && !book[field]) book[field] = today();
  }

  // '2026-11-03' → '3 November 2026', with a non-breaking space after the day
  function formatDate(iso) {
    if (!isIsoDate(iso)) return '';
    var parts = iso.split('-');
    return parseInt(parts[2], 10) + ' ' + MONTHS[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
  }

  function bookDatesHtml(book) {
    var parts = [];
    [['started', 'Started'], ['finished', 'Finished'], ['abandoned', 'Abandoned']].forEach(function (pair) {
      var iso = book[pair[0]];
      if (isIsoDate(iso)) {
        parts.push(pair[1] + ' <time datetime="' + iso + '">' + formatDate(iso) + '</time>');
      }
    });
    if (!parts.length) return '';
    return '<p class="book-detail-dates">' + parts.join(' <span aria-hidden="true">·</span> ') + '</p>';
  }

  // =============================================================
  // COVERS
  // =============================================================

  var COVER_WIDTH       = 600;  // px; roughly 2x the largest size a cover is shown at
  var COVER_PREVIEW_KEY = 'bookshelf_cover_previews';

  // A freshly uploaded cover isn't served by GitHub Pages until the site
  // redeploys (about a minute), so this session shows the uploaded image meanwhile.
  function readCoverPreviews() {
    try {
      return JSON.parse(sessionStorage.getItem(COVER_PREVIEW_KEY)) || {};
    } catch (e) { return {}; }
  }

  function rememberCoverPreview(path, dataUrl) {
    var previews = readCoverPreviews();
    previews[path] = dataUrl;
    try {
      sessionStorage.setItem(COVER_PREVIEW_KEY, JSON.stringify(previews));
    } catch (e) { /* storage full or unavailable: the cover appears after deploy */ }
  }

  function coverSrc(cover) {
    return readCoverPreviews()[cover] || cover;
  }

  function slugify(str) {
    return (str || '').toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'cover';
  }

  // covers/<title>.jpg, unless another book already uses that file
  function coverPathFor(book, title) {
    var path = 'covers/' + slugify(title) + '.jpg';
    var taken = Object.keys(_db || {}).some(function (listId) {
      return _db[listId].some(function (b) { return b.id !== book.id && b.cover === path; });
    });
    return taken ? 'covers/' + slugify(title) + '-' + book.id + '.jpg' : path;
  }

  // Scales an image file down to COVER_WIDTH and resolves to a JPEG data URL
  function resizeImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale  = Math.min(1, COVER_WIDTH / img.naturalWidth);
        var canvas = document.createElement('canvas');
        canvas.width  = Math.round(img.naturalWidth  * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';  // JPEG has no transparency
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file doesn’t look like an image.'));
      };
      img.src = url;
    });
  }

  // =============================================================
  // RENDER FUNCTIONS
  // =============================================================

  function renderBookCard(book, listId) {
    var href = 'book.html?id=' + encodeURIComponent(book.id) + '&list=' + encodeURIComponent(listId);
    return [
      '<a href="' + href + '" class="book-card">',
        '<div class="book-card-cover" aria-hidden="true">',
          book.cover
            ? '<img src="' + escapeHtml(coverSrc(book.cover)) + '" alt="" loading="lazy">'
            : '<div class="book-card-placeholder"><span>' + escapeHtml(book.title) + '</span></div>',
        '</div>',
        '<div class="book-card-body">',
          '<p class="book-card-title">' + escapeHtml(book.title)  + '</p>',
          '<p class="book-card-author">' + escapeHtml(book.author) + '</p>',
        '</div>',
      '</a>',
    ].join('');
  }

  function bookGrid(books, listId) {
    return '<div class="book-grid">' +
      books.map(function (b) { return renderBookCard(b, listId); }).join('') +
      '</div>';
  }

  // Finished books, grouped by the year they were finished (newest first).
  // Books without a finished date go under "Earlier".
  function renderFinished(books) {
    if (!books.some(function (b) { return isIsoDate(b.finished); })) {
      return bookGrid(books, 'archive-finished');
    }

    var groups = {};
    books.forEach(function (b) {
      var year = isIsoDate(b.finished) ? b.finished.slice(0, 4) : 'earlier';
      (groups[year] = groups[year] || []).push(b);
    });

    var years = Object.keys(groups).filter(function (y) { return y !== 'earlier'; }).sort().reverse();
    if (groups.earlier) years.push('earlier');

    return years.map(function (year) {
      var list = groups[year].slice();
      if (year !== 'earlier') {
        list.sort(function (a, b) { return b.finished.localeCompare(a.finished); });
      }
      return [
        '<section class="year-group">',
          '<h2 class="year-heading">',
            year === 'earlier' ? 'Earlier' : year,
            ' <span class="year-count">' + list.length + ' ' + (list.length === 1 ? 'book' : 'books') + '</span>',
          '</h2>',
          bookGrid(list, 'archive-finished'),
        '</section>',
      ].join('');
    }).join('');
  }

  // Shows `contentHtml` (a grid of `books` by default), or `emptyHtml` if there are none
  function fillPanel(panelId, books, listId, emptyHtml, contentHtml) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    panel.innerHTML = books.length ? (contentHtml || bookGrid(books, listId)) : emptyHtml;
    wireEmptyAddButtons(panel);
  }

  // =============================================================
  // SHARED NAV SETUP
  // =============================================================

  var ICON_HAMBURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  var ICON_CLOSE_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/></svg>';

  var NAV_LINKS = [
    { href: 'index.html',   label: 'Reading' },
    { href: 'to-read.html', label: 'To Read' },
    { href: 'archive.html', label: 'Archive' },
  ];

  // Editing controls are marked data-owner-only in the HTML and hidden by CSS
  // unless body.is-owner is set, i.e. a GitHub token is connected.
  function initNav(defaultSearchList) {
    document.body.classList.toggle('is-owner', isConfigured());

    var btnSearch   = document.getElementById('btn-search');
    var btnSettings = document.getElementById('btn-settings');
    if (btnSearch)   btnSearch.innerHTML   = ICON_SEARCH_NAV;
    if (btnSettings) btnSettings.innerHTML = ICON_SETTINGS_NAV;

    if (btnSearch) {
      btnSearch.addEventListener('click', function () {
        openSearchModal(defaultSearchList || 'currently-reading');
      });
    }
    if (btnSettings) {
      btnSettings.addEventListener('click', function () {
        openSettingsModal();
      });
    }

    var btnMenu = document.getElementById('btn-menu');
    if (!btnMenu) return;
    btnMenu.innerHTML = ICON_HAMBURGER;
    btnMenu.setAttribute('aria-controls', 'nav-drawer');

    var nav    = btnMenu.closest('.site-nav');
    var drawer = null;

    function closeDrawer(returnFocus) {
      if (drawer) { drawer.remove(); drawer = null; }
      btnMenu.innerHTML = ICON_HAMBURGER;
      btnMenu.setAttribute('aria-label', 'Open menu');
      btnMenu.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onDrawerKeydown);
      if (returnFocus) btnMenu.focus();
    }

    function onOutsideClick(e) {
      if (nav && !nav.contains(e.target)) closeDrawer(false);
    }

    function onDrawerKeydown(e) {
      if (e.key === 'Escape') closeDrawer(true);
    }

    btnMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      if (drawer) { closeDrawer(false); return; }

      var page = location.pathname.split('/').pop() || 'index.html';

      drawer = document.createElement('div');
      drawer.className = 'nav-drawer';
      drawer.id = 'nav-drawer';
      drawer.innerHTML = [
        '<ul class="nav-drawer-links" role="list">',
          NAV_LINKS.map(function (l) {
            var current = page === l.href ? ' aria-current="page"' : '';
            return '<li><a href="' + l.href + '" class="nav-drawer-link"' + current + '>' + l.label + '</a></li>';
          }).join(''),
        '</ul>',
        '<div class="nav-drawer-divider"></div>',
        '<div class="nav-drawer-actions">',
          '<button class="nav-icon-btn" id="drawer-btn-search" aria-label="Search for a book" data-owner-only>' + ICON_SEARCH_NAV + '</button>',
          '<button class="nav-icon-btn" id="drawer-btn-settings" aria-label="Settings">' + ICON_SETTINGS_NAV + '</button>',
        '</div>',
      ].join('');

      nav.appendChild(drawer);
      btnMenu.innerHTML = ICON_CLOSE_MENU;
      btnMenu.setAttribute('aria-label', 'Close menu');
      btnMenu.setAttribute('aria-expanded', 'true');

      drawer.querySelector('#drawer-btn-search').addEventListener('click', function () {
        closeDrawer(false);
        openSearchModal(defaultSearchList || 'currently-reading');
      });
      drawer.querySelector('#drawer-btn-settings').addEventListener('click', function () {
        closeDrawer(false);
        openSettingsModal();
      });

      document.addEventListener('keydown', onDrawerKeydown);
      setTimeout(function () { document.addEventListener('click', onOutsideClick); }, 0);
    });
  }

  // =============================================================
  // TABS  (shared by To Read and Archive pages)
  // =============================================================

  function initTabs(tabs) {
    var tabRow = document.getElementById('tab-row');
    if (!tabRow) return;

    tabRow.innerHTML = tabs.map(function (t, i) {
      return [
        '<button class="tab-btn" role="tab" id="tab-' + t.panelId + '" aria-controls="' + t.panelId + '"',
          ' data-list="' + t.listId + '" data-panel="' + t.panelId + '"',
          ' aria-selected="' + (i === 0 ? 'true' : 'false') + '">',
          t.label,
        '</button>',
      ].join('');
    }).join('');

    tabs.forEach(function (t) {
      var panel = document.getElementById(t.panelId);
      if (panel) panel.setAttribute('aria-labelledby', 'tab-' + t.panelId);
    });

    tabRow.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(tabs, btn.dataset.list); });
    });

    switchTab(tabs, tabs[0].listId);
  }

  function switchTab(tabs, activeListId) {
    tabs.forEach(function (t) {
      var btn    = document.querySelector('.tab-btn[data-list="' + t.listId + '"]');
      var panel  = document.getElementById(t.panelId);
      var active = t.listId === activeListId;
      if (btn)   btn.setAttribute('aria-selected', String(active));
      if (panel) panel.classList.toggle('active', active);
    });
  }

  // =============================================================
  // PAGE RENDERING
  // =============================================================

  // Each page registers a render function, so after a change (like adding
  // a book) it can redraw from the in-memory shelf instead of reloading.
  var _renderPage = null;

  function showPage(render) {
    _renderPage = render;
    loadDB().then(function (db) {
      hideLoading();
      render(db);
    }).catch(loadFailed);
  }

  function rerenderPage() {
    if (_renderPage && _db) _renderPage(_db);
  }

  // =============================================================
  // PAGE: CURRENTLY READING
  // =============================================================

  function initCurrentlyReading() {
    initNav('currently-reading');

    var btnAdd = document.getElementById('btn-add');
    if (btnAdd) {
      btnAdd.addEventListener('click', function () { openSearchModal('currently-reading'); });
    }

    showPage(function (db) {
      var books = db['currently-reading'];
      var grid  = document.getElementById('book-grid');
      var empty = document.getElementById('empty-state');

      if (grid) {
        grid.hidden    = books.length === 0;
        grid.innerHTML = books.map(function (b) { return renderBookCard(b, 'currently-reading'); }).join('');
      }

      if (empty) {
        empty.hidden    = books.length !== 0;
        empty.innerHTML = books.length ? '' : emptyContent('currently-reading', isConfigured()
          ? 'Nothing here yet. Add the book you’re reading now.'
          : 'Not reading anything right now.');
        wireEmptyAddButtons(empty);
      }

      var upNext        = db['to-read-bought'];
      var toReadSection = document.getElementById('to-read-section');
      var toReadGrid    = document.getElementById('to-read-grid');
      if (toReadSection && toReadGrid) {
        toReadSection.hidden = upNext.length === 0;
        toReadGrid.innerHTML = upNext.map(function (b) { return renderBookCard(b, 'to-read-bought'); }).join('');
      }
    });
  }

  // =============================================================
  // PAGE: TO READ
  // =============================================================

  function initToRead() {
    var tabs = [
      { listId: 'to-read-bought',  panelId: 'panel-bought',  label: 'Bought & ready to read' },
      { listId: 'to-read-someday', panelId: 'panel-someday', label: 'Want to read someday'  },
    ];

    initNav('to-read-bought');
    initTabs(tabs);

    // "Add book" adds to whichever tab is active
    var btnAdd = document.getElementById('btn-add');
    if (btnAdd) {
      btnAdd.addEventListener('click', function () {
        var activeBtn = document.querySelector('.tab-btn[aria-selected="true"]');
        openSearchModal(activeBtn ? activeBtn.dataset.list : 'to-read-bought');
      });
    }

    showPage(function (db) {
      fillPanel('panel-bought', db['to-read-bought'], 'to-read-bought',
        emptyPanel('to-read-bought', 'No books queued up yet.'));
      fillPanel('panel-someday', db['to-read-someday'], 'to-read-someday',
        emptyPanel('to-read-someday', 'The someday list is empty.'));
    });
  }

  // =============================================================
  // PAGE: ARCHIVE
  // =============================================================

  function initArchive() {
    var tabs = [
      { listId: 'archive-finished',  panelId: 'panel-finished',  label: 'Finished'  },
      { listId: 'archive-abandoned', panelId: 'panel-abandoned', label: 'Abandoned' },
    ];

    initNav('archive-finished');
    initTabs(tabs);

    showPage(function (db) {
      var finished = db['archive-finished'];
      fillPanel('panel-finished', finished, 'archive-finished',
        emptyPanel(null, 'No finished books yet.'), renderFinished(finished));
      fillPanel('panel-abandoned', db['archive-abandoned'], 'archive-abandoned',
        emptyPanel(null, 'Nothing abandoned — impressive.'));
    });
  }

  // =============================================================
  // PAGE: BOOK DETAIL
  // =============================================================

  function initBookDetail() {
    initNav('currently-reading');

    var params = new URLSearchParams(location.search);
    var bookId = params.get('id');
    var listId = params.get('list');

    if (!bookId || !listId) {
      location.replace('index.html');
      return;
    }

    showPage(function (db) {
      var list = db[listId];
      if (!list) { location.replace('index.html'); return; }

      var book = list.find(function (b) { return b.id === bookId; });
      if (!book) {
        showToast('Book not found.', 'error');
        setTimeout(function () { location.replace(LIST_PAGE[listId] || 'index.html'); }, 1500);
        return;
      }

      renderBookDetail(book, listId);
    });
  }

  function renderBookDetail(book, currentList) {
    var backPage  = LIST_PAGE[currentList] || 'index.html';
    var backLabel = LISTS[currentList] || 'Back';

    var content = document.getElementById('book-detail-content');
    if (!content) return;

    document.title = book.title + ' — Elliot’s bookshelf';

    content.innerHTML = [
      '<a href="' + backPage + '" class="back-link">' + ICON_ARROW_LEFT + ' ' + escapeHtml(backLabel) + '</a>',
      '<div class="book-detail">',
        '<div class="book-detail-cover">',
          book.cover
            ? '<img src="' + escapeHtml(coverSrc(book.cover)) + '" alt="' + escapeHtml(book.title) + ' cover">'
            : '<div class="book-detail-placeholder"><span>' + escapeHtml(book.title) + '</span></div>',
        '</div>',
        '<div class="book-detail-info">',
          '<span class="book-detail-list-badge">' + escapeHtml(LISTS[currentList] || currentList) + '</span>',
          '<h1 class="book-detail-title">' + escapeHtml(book.title)  + '</h1>',
          '<p class="book-detail-author">'  + escapeHtml(book.author) + '</p>',
          bookDatesHtml(book),
          // book.isbn ? '<p class="book-detail-isbn">ISBN ' + escapeHtml(book.isbn) + '</p>' : '',
          isConfigured() ? [
            '<div class="book-actions-group" id="move-action">',
              '<div class="move-action-btns">',
                '<button class="btn btn-secondary" id="btn-move">Move book</button>',
                '<button class="btn btn-secondary" id="btn-edit">Edit details</button>',
              '</div>',
            '</div>',
          ].join('') : '',
        '</div>',
      '</div>',
    ].join('');

    var btnMove = document.getElementById('btn-move');
    if (!btnMove) return;

    document.getElementById('btn-edit').addEventListener('click', function () {
      openEditModal(book, currentList);
    });

    btnMove.addEventListener('click', function () {
      var moveOptions = Object.keys(LISTS).filter(function (id) {
        return id !== currentList;
      }).map(function (id) {
        return '<option value="' + id + '">' + escapeHtml(LISTS[id]) + '</option>';
      }).join('');

      var action = document.getElementById('move-action');
      action.innerHTML = [
        '<select id="move-select" aria-label="Choose a shelf">',
          moveOptions,
          '<option disabled>────────</option>',
          '<option value="__remove__">Remove book entirely</option>',
        '</select>',
        '<div class="move-action-btns">',
          '<button class="btn btn-primary" id="btn-confirm">Confirm</button>',
          '<button class="btn btn-ghost" id="btn-cancel">Cancel</button>',
        '</div>',
      ].join('');
      document.getElementById('move-select').focus();

      document.getElementById('btn-cancel').addEventListener('click', function () {
        renderBookDetail(book, currentList);
      });

      document.getElementById('btn-confirm').addEventListener('click', function () {
        var target = document.getElementById('move-select').value;
        var btn    = document.getElementById('btn-confirm');
        btn.disabled    = true;
        btn.textContent = 'Saving…';

        if (target === '__remove__') {
          removeBook(book.id, currentList).then(function () {
            showToast('Book removed.', 'default');
            setTimeout(function () { location.replace(backPage); }, 400);
          }).catch(function (err) {
            console.error(err);
            btn.disabled    = false;
            btn.textContent = 'Confirm';
            showToast('Remove failed. Please try again.', 'error');
          });
        } else {
          moveBook(book.id, currentList, target).then(function () {
            showToast('Moved to ' + LISTS[target] + '.', 'success');
            setTimeout(function () { location.replace(LIST_PAGE[target] || 'index.html'); }, 500);
          }).catch(function (err) {
            console.error(err);
            btn.disabled    = false;
            btn.textContent = 'Confirm';
            showToast('Move failed. Please try again.', 'error');
          });
        }
      });
    });
  }

  // =============================================================
  // EDIT MODAL
  // =============================================================

  function textField(id, label, value, note) {
    return [
      '<div class="field">',
        '<label for="' + id + '">' + label + '</label>',
        '<input',
          ' type="text"',
          ' id="' + id + '"',
          ' value="' + escapeHtml(value || '') + '"',
          ' autocomplete="off">',
        note ? '<p class="field-note">' + note + '</p>' : '',
      '</div>',
    ].join('');
  }

  function dateField(id, label, value) {
    return [
      '<div class="field">',
        '<label for="' + id + '">' + label + '</label>',
        '<input',
          ' type="date"',
          ' id="' + id + '"',
          ' value="' + (isIsoDate(value) ? value : '') + '">',
      '</div>',
    ].join('');
  }

  function openEditModal(book, listId) {
    var overlay       = createOverlay();
    var showAbandoned = listId === 'archive-abandoned' || isIsoDate(book.abandoned);

    overlay.innerHTML = [
      '<div class="modal">',
        '<div class="modal-header">',
          '<h2 class="modal-title" id="modal-title">Edit details</h2>',
          '<button class="modal-close" type="button" aria-label="Close">' + ICON_X + '</button>',
        '</div>',
        '<form class="modal-form" id="edit-form" novalidate>',
          '<div class="modal-body">',
            textField('edit-title', 'Title', book.title),
            textField('edit-author', 'Author', book.author),
            '<div class="edit-cover">',
              '<div class="preview-cover" id="edit-cover-preview">',
                book.cover ? '<img src="' + escapeHtml(coverSrc(book.cover)) + '" alt="">' : '',
              '</div>',
              '<div class="edit-cover-fields">',
                textField('edit-cover', 'Cover', book.cover,
                  'A path like <code>covers/my-book.jpg</code>, or an image URL.'),
                '<div class="field">',
                  '<label for="edit-cover-file">Or upload a new cover</label>',
                  '<input type="file" id="edit-cover-file" accept="image/*">',
                  '<p class="field-note">Resized to ' + COVER_WIDTH + '&#8201;px wide and saved to <code>covers/</code> in your repo.</p>',
                '</div>',
              '</div>',
            '</div>',
            '<div class="field-row">',
              dateField('edit-started', 'Started', book.started),
              dateField('edit-finished', 'Finished', book.finished),
              showAbandoned ? dateField('edit-abandoned', 'Abandoned', book.abandoned) : '',
            '</div>',
            '<div id="edit-feedback"></div>',
          '</div>',
          '<div class="modal-footer">',
            '<button class="btn btn-secondary" type="button" id="btn-edit-cancel">Cancel</button>',
            '<button class="btn btn-primary" type="submit" id="btn-edit-save">Save changes</button>',
          '</div>',
        '</form>',
      '</div>',
    ].join('');

    function value(id) {
      var el = overlay.querySelector('#' + id);
      return el ? el.value.trim() : '';
    }

    var fileInput = overlay.querySelector('#edit-cover-file');
    var preview   = overlay.querySelector('#edit-cover-preview');
    var feedback  = overlay.querySelector('#edit-feedback');
    var pending   = null;  // resized data URL of a chosen file

    overlay.querySelector('.modal-close').addEventListener('click', closeModal);
    overlay.querySelector('#btn-edit-cancel').addEventListener('click', closeModal);

    fileInput.addEventListener('change', function () {
      pending = null;
      feedback.innerHTML = '';
      if (!fileInput.files[0]) return;
      resizeImage(fileInput.files[0]).then(function (dataUrl) {
        pending = dataUrl;
        preview.innerHTML = '<img src="' + dataUrl + '" alt="">';
      }).catch(function (err) {
        fileInput.value = '';
        feedback.innerHTML = '<p class="settings-error">' + escapeHtml(err.message) + '</p>';
      });
    });

    overlay.querySelector('#edit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var title = value('edit-title');
      if (!title) {
        feedback.innerHTML = '<p class="settings-error">A book needs a title.</p>';
        return;
      }

      var btn = overlay.querySelector('#btn-edit-save');
      btn.disabled    = true;
      btn.textContent = 'Saving…';
      feedback.innerHTML = '';

      var uploading = !!pending;
      var coverStep = Promise.resolve(value('edit-cover'));
      if (uploading) {
        var path = coverPathFor(book, title);
        coverStep = uploadFile(path, pending.split(',')[1], 'Add cover for ' + title).then(function () {
          rememberCoverPreview(path, pending);
          return path;
        });
      }

      coverStep.then(function (cover) {
        var fields = {
          title:    title,
          author:   value('edit-author') || 'Unknown Author',
          cover:    cover,
          started:  value('edit-started'),
          finished: value('edit-finished'),
        };
        if (showAbandoned) fields.abandoned = value('edit-abandoned');
        return editBook(book.id, listId, fields);
      }).then(function (updated) {
        closeModal();
        showToast(uploading
          ? 'Saved. The new cover reaches the public site in about a minute.'
          : 'Saved.', 'success');
        renderBookDetail(updated, listId);
      }).catch(function (err) {
        console.error(err);
        btn.disabled    = false;
        btn.textContent = 'Save changes';
        feedback.innerHTML = '<p class="settings-error">Couldn’t save: ' + escapeHtml(err.message) + '</p>';
      });
    });
  }

  // =============================================================
  // HELPERS: empty states, load errors
  // =============================================================

  // The contents of an empty state; pass a listId to include an "Add a book" button (owner only)
  function emptyContent(listId, message) {
    var addBtn = listId && isConfigured()
      ? '<button class="btn btn-primary empty-add-btn" data-list="' + listId + '">' + ICON_PLUS + ' Add a book</button>'
      : '';
    return ICON_BOOK_OPEN + '<p>' + escapeHtml(message) + '</p>' + addBtn;
  }

  function emptyPanel(listId, message) {
    return '<div class="empty-state">' + emptyContent(listId, message) + '</div>';
  }

  function wireEmptyAddButtons(root) {
    root.querySelectorAll('.empty-add-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { openSearchModal(btn.dataset.list); });
    });
  }

  function loadFailed(err) {
    console.error(err);
    hideLoading();
    showToast(isConfigured()
      ? 'Could not load your books. Check Settings.'
      : 'Could not load the bookshelf. Please try again later.', 'error');
  }

  // =============================================================
  // PUBLIC API
  // =============================================================

  window.Bookshelf = {
    initCurrentlyReading: initCurrentlyReading,
    initToRead:           initToRead,
    initArchive:          initArchive,
    initBookDetail:       initBookDetail,
  };

})();
