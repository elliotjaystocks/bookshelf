/* =============================================================
   BOOKSHELF — app.js
   Single-file bundle. No ES modules, no build step required.
   Works over file://, localhost, and GitHub Pages.
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

  function apiRequest(path, method, body) {
    var config = getConfig();
    if (!config) return Promise.reject(new Error('GitHub is not configured.'));

    var url = 'https://api.github.com/repos/' + config.username + '/' + config.repo + '/contents/' + path;
    var headers = {
      'Authorization':        'Bearer ' + config.token,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    var options = { method: method || 'GET', headers: headers };

    if (body) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    return fetch(url, options).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (err) {
          throw new Error(err.message || ('GitHub API error ' + response.status));
        });
      }
      return response.json();
    });
  }

  function readFile() {
    return apiRequest(FILE_PATH, 'GET', null).then(function (data) {
      return { content: decodeContent(data.content), sha: data.sha };
    }).catch(function (err) {
      if (err.message.indexOf('Not Found') !== -1 || err.message.indexOf('404') !== -1) {
        return { content: null, sha: null };
      }
      throw err;
    });
  }

  function writeFile(content, sha) {
    var body = {
      message: 'Update bookshelf \u2014 ' + new Date().toISOString().slice(0, 10),
      content: encodeContent(content),
    };
    if (sha) body.sha = sha;
    return apiRequest(FILE_PATH, 'PUT', body);
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

  var _db  = null;
  var _sha = null;

  function readCache() {
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeCache() {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ db: _db, sha: _sha }));
    } catch (e) { /* sessionStorage unavailable */ }
  }

  function loadDB(force) {
    if (!force) {
      var cached = readCache();
      if (cached) {
        _db  = cached.db;
        _sha = cached.sha;
        return Promise.resolve(_db);
      }
    }
    return readFile().then(function (result) {
      _sha = result.sha;
      _db  = result.content ? parseMarkdown(result.content) : createEmptyDB();
      writeCache();
      return _db;
    });
  }

  function saveDB() {
    var content = serializeMarkdown(_db);
    return writeFile(content, _sha).then(function (result) {
      _sha = result.content.sha;
      writeCache();
    });
  }

  function initDB() {
    return readFile().then(function (result) {
      _sha = result.sha;
      if (result.content === null) {
        _db = createEmptyDB();
        return saveDB();
      } else {
        _db = parseMarkdown(result.content);
        writeCache();
      }
    });
  }

  function addBook(bookData, listId) {
    if (!_db) return Promise.reject(new Error('Database not loaded'));
    var book = createBook(bookData);
    _db[listId].push(book);
    return saveDB().then(function () { return book; });
  }

  function removeBook(bookId, listId) {
    if (!_db) return Promise.reject(new Error('Database not loaded'));
    _db[listId] = _db[listId].filter(function (b) { return b.id !== bookId; });
    return saveDB();
  }

  function moveBook(bookId, fromList, toList) {
    if (!_db) return Promise.reject(new Error('Database not loaded'));
    var idx = _db[fromList].findIndex(function (b) { return b.id === bookId; });
    if (idx === -1) return Promise.reject(new Error('Book not found'));
    var book = _db[fromList].splice(idx, 1)[0];
    _db[toList].push(book);
    return saveDB().then(function () { return book; });
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

  var ICON_CHEVRON_SM = '<svg class="book-row-chevron" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

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

  function closeModal() {
    if (!_activeOverlay) return;
    _activeOverlay.classList.remove('open');
    var overlay = _activeOverlay;
    _activeOverlay = null;
    setTimeout(function () { overlay.remove(); }, 220);
  }

  function createOverlay(closeable) {
    var overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    if (closeable) {
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) closeModal();
      });
      function onKeydown(e) {
        if (e.key === 'Escape') {
          closeModal();
          document.removeEventListener('keydown', onKeydown);
        }
      }
      document.addEventListener('keydown', onKeydown);
    }

    var root = document.getElementById('modal-root');
    root.appendChild(overlay);
    _activeOverlay = overlay;

    // Two rAF calls ensure the transition fires after paint
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.classList.add('open');
      });
    });

    return overlay;
  }

  // =============================================================
  // SEARCH MODAL
  // =============================================================

  function openSearchModal(defaultList) {
    defaultList = defaultList || 'currently-reading';
    var overlay = createOverlay(true);

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
          ' placeholder="Title, author, or ISBN\u2026" autocomplete="off" aria-label="Search for books">',
      '</div>',
      '<div id="search-results" class="search-results">',
        '<p class="search-status">Start typing to search the Open Library catalogue\u2026</p>',
      '</div>',
    ].join('');

    var input   = overlay.querySelector('#search-query');
    var results = overlay.querySelector('#search-results');
    var debounce = null;

    input.addEventListener('input', function () {
      clearTimeout(debounce);
      var q = input.value.trim();
      if (q.length < 2) {
        results.innerHTML = '<p class="search-status">Start typing to search the Open Library catalogue\u2026</p>';
        return;
      }
      results.innerHTML = '<div class="search-status"><div class="spinner"></div></div>';

      debounce = setTimeout(function () {
        searchBooks(q).then(function (books) {
          if (!books.length) {
            results.innerHTML = '<p class="search-status">No results found. Try a different search.</p>';
            return;
          }
          results.innerHTML = books.map(function (b, i) {
            return [
              '<div class="search-result" role="button" tabindex="0" data-index="' + i + '">',
                '<div class="search-result-cover">',
                  b.cover ? '<img src="' + escapeHtml(b.cover) + '" alt="" loading="lazy">' : '',
                '</div>',
                '<div class="search-result-info">',
                  '<p class="search-result-title">' + escapeHtml(b.title) + '</p>',
                  '<p class="search-result-meta">' + escapeHtml(b.author) + (b.year ? ' \u00b7 ' + b.year : '') + '</p>',
                '</div>',
                ICON_CHEVRON_MD,
              '</div>',
            ].join('');
          }).join('');

          results.querySelectorAll('.search-result').forEach(function (el) {
            var pick = function () {
              var idx = parseInt(el.dataset.index, 10);
              showPreviewView(overlay, books[idx], defaultList);
            };
            el.addEventListener('click', pick);
            el.addEventListener('keydown', function (e) {
              if (e.key === 'Enter' || e.key === ' ') pick();
            });
          });

        }).catch(function () {
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
      '<p class="list-options-label">Add to\u2026</p>',
      '<div id="list-options">',
        Object.keys(LISTS).map(function (id) {
          return [
            '<label class="list-option">',
              '<input type="radio" name="target-list" value="' + id + '"' + (id === defaultList ? ' checked' : '') + '>',
              '<span class="list-option-name">' + escapeHtml(LISTS[id]) + '</span>',
            '</label>',
          ].join('');
        }).join(''),
      '</div>',
    ].join('');

    overlay.querySelector('#modal-footer').innerHTML = [
      '<button class="btn btn-ghost" id="btn-back">' + ICON_ARROW_LEFT + ' Back to results</button>',
      '<span style="flex:1"></span>',
      '<button class="btn btn-primary" id="btn-add-confirm">Add book</button>',
    ].join('');

    overlay.querySelector('#btn-back').addEventListener('click', function () {
      showSearchView(overlay, defaultList);
    });

    overlay.querySelector('#btn-add-confirm').addEventListener('click', function () {
      var selected = overlay.querySelector('input[name="target-list"]:checked');
      if (!selected) return;

      var btn = overlay.querySelector('#btn-add-confirm');
      btn.disabled    = true;
      btn.textContent = 'Saving\u2026';

      addBook(bookData, selected.value).then(function () {
        closeModal();
        showToast('Book added to your shelf.', 'success');
        setTimeout(function () { location.reload(); }, 400);
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

  function openSettingsModal(isRequired) {
    var overlay = createOverlay(!isRequired);
    var config  = getConfig() || {};

    overlay.innerHTML = [
      '<div class="modal">',
        '<div class="modal-header">',
          '<h2 class="modal-title">Connect to GitHub</h2>',
          !isRequired ? '<button class="modal-close" aria-label="Close">' + ICON_X + '</button>' : '',
        '</div>',
        '<div class="modal-body">',
          '<p class="settings-intro">',
            'Elliot’s bookshelf saves your reading list to a <code>books.md</code> file in a GitHub',
            'repository of your choice. You\u2019ll need a personal access token so the app ',
            'can read and write that file on your behalf.<br><br>',
            '<strong>To create a token:</strong> go to ',
            '<a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener">',
              'GitHub \u2192 Settings \u2192 Developer settings \u2192 Fine-grained tokens',
            '</a>, ',
            'click <em>Generate new token</em>, select your bookshelf repo under ',
            '<em>Repository access</em>, and grant ',
            '<strong>Contents \u2192 Read and write</strong> permission.',
          '</p>',
          '<div class="field">',
            '<label for="cfg-username">GitHub username</label>',
            '<input type="text" id="cfg-username" value="' + escapeHtml(config.username || '') + '"',
              ' placeholder="your-username" autocomplete="off" spellcheck="false">',
          '</div>',
          '<div class="field">',
            '<label for="cfg-repo">Repository name</label>',
            '<input type="text" id="cfg-repo" value="' + escapeHtml(config.repo || '') + '"',
              ' placeholder="bookshelf" autocomplete="off" spellcheck="false">',
            '<p class="field-note">The repository where <code>books.md</code> will live.</p>',
          '</div>',
          '<div class="field">',
            '<label for="cfg-token">Personal access token</label>',
            '<input type="password" id="cfg-token" value="' + escapeHtml(config.token || '') + '"',
              ' placeholder="github_pat_\u2026" autocomplete="off" spellcheck="false">',
            '<p class="field-note">Stored only in your browser\u2019s local storage. Never shared with anyone.</p>',
          '</div>',
          '<div id="settings-feedback"></div>',
        '</div>',
        '<div class="modal-footer">',
          !isRequired ? '<button class="btn btn-ghost" id="btn-settings-refresh" title="Clear the local cache and reload data from GitHub">Refresh data</button>' : '',
          !isRequired ? '<button class="btn btn-secondary" id="btn-settings-cancel">Cancel</button>' : '',
          '<button class="btn btn-primary" id="btn-settings-save">Save &amp; connect</button>',
        '</div>',
      '</div>',
    ].join('');

    if (!isRequired) {
      var closeBtn      = overlay.querySelector('.modal-close');
      var cancelBtn     = overlay.querySelector('#btn-settings-cancel');
      var refreshBtn    = overlay.querySelector('#btn-settings-refresh');
      if (closeBtn)  closeBtn.addEventListener('click', closeModal);
      if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
      if (refreshBtn) refreshBtn.addEventListener('click', function () {
        sessionStorage.removeItem(SESSION_KEY);
        location.reload();
      });
    }

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
      btn.textContent = 'Connecting\u2026';
      feedback.innerHTML = '';

      // Validate credentials first, then save
      validateConfig(username, repo, token).then(function () {
        saveConfig({ username: username, repo: repo, token: token });
        return initDB();
      }).then(function () {
        closeModal();
        showToast('Connected! Loading your books\u2026', 'success');
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
  // RENDER FUNCTIONS
  // =============================================================

  function renderBookCard(book, listId) {
    var href = 'book.html?id=' + encodeURIComponent(book.id) + '&list=' + encodeURIComponent(listId);
    return [
      '<a href="' + href + '" class="book-card">',
        '<div class="book-card-cover" aria-hidden="true">',
          book.cover
            ? '<img src="' + escapeHtml(book.cover) + '" alt="' + escapeHtml(book.title) + ' cover" loading="lazy">'
            : '<div class="book-card-placeholder"><span>' + escapeHtml(book.title) + '</span></div>',
        '</div>',
        '<div class="book-card-body">',
          '<p class="book-card-title">' + escapeHtml(book.title)  + '</p>',
          '<p class="book-card-author">' + escapeHtml(book.author) + '</p>',
        '</div>',
      '</a>',
    ].join('');
  }

  function renderBookRow(book, listId) {
    var href = 'book.html?id=' + encodeURIComponent(book.id) + '&list=' + encodeURIComponent(listId);
    return [
      '<a href="' + href + '" class="book-row">',
        '<div class="book-row-cover" aria-hidden="true">',
          book.cover
            ? '<img src="' + escapeHtml(book.cover) + '" alt="" loading="lazy">'
            : '<div class="book-row-placeholder"></div>',
        '</div>',
        '<div class="book-row-info">',
          '<p class="book-row-title">'  + escapeHtml(book.title)  + '</p>',
          '<p class="book-row-author">' + escapeHtml(book.author) + '</p>',
        '</div>',
        ICON_CHEVRON_SM,
      '</a>',
    ].join('');
  }

  // =============================================================
  // SHARED NAV SETUP
  // =============================================================

  var ICON_HAMBURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
  var ICON_CLOSE_MENU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="4" x2="20" y2="20"/><line x1="20" y1="4" x2="4" y2="20"/></svg>';

  function initNav(defaultSearchList) {
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
        openSettingsModal(false);
      });
    }

    var btnMenu = document.getElementById('btn-menu');
    if (!btnMenu) return;
    btnMenu.innerHTML = ICON_HAMBURGER;

    var nav = btnMenu.closest('.site-nav');
    var drawer = null;

    function closeDrawer() {
      if (drawer) { drawer.remove(); drawer = null; }
      btnMenu.innerHTML = ICON_HAMBURGER;
      btnMenu.setAttribute('aria-label', 'Open menu');
      btnMenu.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutsideClick);
    }

    function onOutsideClick(e) {
      if (nav && !nav.contains(e.target)) closeDrawer();
    }

    btnMenu.addEventListener('click', function (e) {
      e.stopPropagation();
      if (drawer) { closeDrawer(); return; }

      // Determine current page for aria-current
      var page = location.pathname.split('/').pop() || 'index.html';

      // Collect aria-current from each nav link in the hidden .nav-links list
      var links = [
        { href: 'index.html',   label: 'Reading'  },
        { href: 'to-read.html', label: 'To Read'  },
        { href: 'archive.html', label: 'Archive'  },
      ];

      var linksHtml = links.map(function (l) {
        var current = (page === l.href || (page === '' && l.href === 'index.html')) ? ' aria-current="page"' : '';
        return '<a href="' + l.href + '" class="nav-drawer-link"' + current + '>' + l.label + '</a>';
      }).join('');

      drawer = document.createElement('div');
      drawer.className = 'nav-drawer';
      drawer.setAttribute('role', 'menu');
      drawer.innerHTML = [
        linksHtml,
        '<div class="nav-drawer-divider"></div>',
        '<div class="nav-drawer-actions">',
          '<button class="nav-icon-btn" id="drawer-btn-search" aria-label="Search for a book">' + ICON_SEARCH_NAV + '</button>',
          '<button class="nav-icon-btn" id="drawer-btn-settings" aria-label="Settings">' + ICON_SETTINGS_NAV + '</button>',
        '</div>',
      ].join('');

      nav.appendChild(drawer);
      btnMenu.innerHTML = ICON_CLOSE_MENU;
      btnMenu.setAttribute('aria-label', 'Close menu');
      btnMenu.setAttribute('aria-expanded', 'true');

      drawer.querySelector('#drawer-btn-search').addEventListener('click', function () {
        closeDrawer();
        openSearchModal(defaultSearchList || 'currently-reading');
      });
      drawer.querySelector('#drawer-btn-settings').addEventListener('click', function () {
        closeDrawer();
        openSettingsModal(false);
      });

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
        '<button class="tab-btn" data-list="' + t.listId + '" data-panel="' + t.panelId + '"',
          ' aria-selected="' + (i === 0 ? 'true' : 'false') + '">',
          t.label,
        '</button>',
      ].join('');
    }).join('');

    tabRow.querySelectorAll('.tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchTab(tabs, btn.dataset.list); });
    });

    switchTab(tabs, tabs[0].listId);
  }

  function switchTab(tabs, activeListId) {
    tabs.forEach(function (t) {
      var btn   = document.querySelector('.tab-btn[data-list="' + t.listId + '"]');
      var panel = document.getElementById(t.panelId);
      var active = t.listId === activeListId;
      if (btn)   btn.setAttribute('aria-selected', String(active));
      if (panel) panel.classList.toggle('active', active);
    });
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

    if (!isConfigured()) {
      hideLoading();
      openSettingsModal(true);
      return;
    }

    loadDB().then(function (db) {
      hideLoading();
      var books   = db['currently-reading'];
      var grid    = document.getElementById('book-grid');
      var empty   = document.getElementById('empty-state');

      if (books.length === 0) {
        if (grid)  grid.hidden  = true;
        if (empty) {
          empty.hidden = false;
          empty.innerHTML = [
            ICON_BOOK_OPEN,
            '<p>Nothing here yet. Add the book you\u2019re reading now.</p>',
            '<button class="btn btn-primary" id="btn-add-empty">' + ICON_PLUS + ' Add a book</button>',
          ].join('');
          var emptyBtn = document.getElementById('btn-add-empty');
          if (emptyBtn) emptyBtn.addEventListener('click', function () { openSearchModal('currently-reading'); });
        }
      } else {
        if (grid) grid.innerHTML = books.map(function (b) { return renderBookCard(b, 'currently-reading'); }).join('');
      }

      var toReadBooks = db['to-read-bought'];
      var toReadSection = document.getElementById('to-read-section');
      var toReadGrid    = document.getElementById('to-read-grid');
      if (toReadSection && toReadGrid && toReadBooks.length > 0) {
        toReadGrid.innerHTML = toReadBooks.map(function (b) { return renderBookCard(b, 'to-read-bought'); }).join('');
        toReadSection.hidden = false;
      }
    }).catch(function (err) {
      console.error(err);
      hideLoading();
      showToast('Could not load your books. Check Settings.', 'error');
    });
  }

  // =============================================================
  // PAGE: TO READ
  // =============================================================

  function initToRead() {
    var tabs = [
      { listId: 'to-read-bought',  panelId: 'panel-bought',  label: 'Bought & ready to read' },
      { listId: 'to-read-someday', panelId: 'panel-someday', label: 'Want to Read Someday'  },
    ];

    initNav('to-read-bought');
    initTabs(tabs);

    var btnAdd = document.getElementById('btn-add');

    if (!isConfigured()) {
      hideLoading();
      openSettingsModal(true);
      return;
    }

    loadDB().then(function (db) {
      hideLoading();

      var total = db['to-read-bought'].length + db['to-read-someday'].length;

      // Bought & Ready panel
      var panelBought = document.getElementById('panel-bought');
      if (panelBought) {
        if (db['to-read-bought'].length === 0) {
          panelBought.innerHTML = emptyPanel('to-read-bought', 'No books queued up yet.');
        } else {
          panelBought.innerHTML = '<div class="book-grid">' +
            db['to-read-bought'].map(function (b) { return renderBookCard(b, 'to-read-bought'); }).join('') +
            '</div>';
        }
      }

      // Want to Read Someday panel
      var panelSomeday = document.getElementById('panel-someday');
      if (panelSomeday) {
        if (db['to-read-someday'].length === 0) {
          panelSomeday.innerHTML = emptyPanel('to-read-someday', 'Your someday list is empty.');
        } else {
          panelSomeday.innerHTML = '<div class="book-grid">' +
            db['to-read-someday'].map(function (b) { return renderBookCard(b, 'to-read-someday'); }).join('') +
            '</div>';
        }
      }

      // Wire up empty-panel add buttons
      document.querySelectorAll('.empty-add-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { openSearchModal(btn.dataset.list); });
      });

      // Wire "Add book" header button to whichever tab is active
      if (btnAdd) {
        btnAdd.addEventListener('click', function () {
          var activeBtn = document.querySelector('.tab-btn[aria-selected="true"]');
          openSearchModal(activeBtn ? activeBtn.dataset.list : 'to-read-bought');
        });
      }

      switchTab(tabs, tabs[0].listId);

    }).catch(function (err) {
      console.error(err);
      hideLoading();
      showToast('Could not load your books. Check Settings.', 'error');
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

    if (!isConfigured()) {
      hideLoading();
      openSettingsModal(true);
      return;
    }

    loadDB().then(function (db) {
      hideLoading();

      var total = db['archive-finished'].length + db['archive-abandoned'].length;

      var panelFinished = document.getElementById('panel-finished');
      if (panelFinished) {
        panelFinished.innerHTML = db['archive-finished'].length === 0
          ? emptyPanel(null, 'No finished books yet.')
          : '<div class="book-grid">' + db['archive-finished'].map(function (b) { return renderBookCard(b, 'archive-finished'); }).join('') + '</div>';
      }

      var panelAbandoned = document.getElementById('panel-abandoned');
      if (panelAbandoned) {
        panelAbandoned.innerHTML = db['archive-abandoned'].length === 0
          ? emptyPanel(null, 'Nothing abandoned \u2014 impressive.')
          : '<div class="book-grid">' + db['archive-abandoned'].map(function (b) { return renderBookCard(b, 'archive-abandoned'); }).join('') + '</div>';
      }

      switchTab(tabs, tabs[0].listId);

    }).catch(function (err) {
      console.error(err);
      hideLoading();
      showToast('Could not load your books. Check Settings.', 'error');
    });
  }

  // =============================================================
  // PAGE: BOOK DETAIL
  // =============================================================

  function initBookDetail() {
    initNav('currently-reading');

    var params  = new URLSearchParams(location.search);
    var bookId  = params.get('id');
    var listId  = params.get('list');

    if (!bookId || !listId) {
      location.replace('index.html');
      return;
    }

    if (!isConfigured()) {
      hideLoading();
      openSettingsModal(true);
      return;
    }

    loadDB().then(function (db) {
      var list = db[listId];
      if (!list) { location.replace('index.html'); return; }

      var book = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === bookId) { book = list[i]; break; }
      }

      if (!book) {
        hideLoading();
        showToast('Book not found.', 'error');
        setTimeout(function () { location.replace(LIST_PAGE[listId] || 'index.html'); }, 1500);
        return;
      }

      document.title = book.title + ' \u2014 Elliot\u2019s bookshelf';
      hideLoading();
      renderBookDetail(book, listId, db);

    }).catch(function (err) {
      console.error(err);
      hideLoading();
      showToast('Could not load book details.', 'error');
    });
  }

  function renderBookDetail(book, currentList, db) {
    var backPage  = LIST_PAGE[currentList] || 'index.html';
    var backLabel = LISTS[currentList] || 'Back';

    var content = document.getElementById('book-detail-content');
    if (!content) return;

    content.innerHTML = [
      '<a href="' + backPage + '" class="back-link">' + ICON_ARROW_LEFT + ' ' + escapeHtml(backLabel) + '</a>',
      '<div class="book-detail">',
        '<div class="book-detail-cover">',
          book.cover
            ? '<img src="' + escapeHtml(book.cover) + '" alt="' + escapeHtml(book.title) + ' cover">'
            : '<div class="book-detail-placeholder"><span>' + escapeHtml(book.title) + '</span></div>',
        '</div>',
        '<div class="book-detail-info">',
          '<span class="book-detail-list-badge">' + escapeHtml(LISTS[currentList] || currentList) + '</span>',
          '<h1 class="book-detail-title">' + escapeHtml(book.title)  + '</h1>',
          '<p class="book-detail-author">'  + escapeHtml(book.author) + '</p>',
          // book.isbn ? '<p class="book-detail-isbn">ISBN ' + escapeHtml(book.isbn) + '</p>' : '',
          '<div class="book-actions-group" id="move-action">',
            '<button class="btn btn-secondary" id="btn-move">Move book</button>',
          '</div>',
        '</div>',
      '</div>',
    ].join('');

    document.getElementById('btn-move').addEventListener('click', function () {
      var moveOptions = Object.keys(LISTS).filter(function (id) {
        return id !== currentList;
      }).map(function (id) {
        return '<option value="' + id + '">' + escapeHtml(LISTS[id]) + '</option>';
      }).join('');

      var action = document.getElementById('move-action');
      action.innerHTML = [
        '<select id="move-select" aria-label="Choose a shelf">',
          moveOptions,
          '<option disabled>\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</option>',
          '<option value="__remove__">Remove book entirely</option>',
        '</select>',
        '<div class="move-action-btns">',
          '<button class="btn btn-primary" id="btn-confirm">Confirm</button>',
          '<button class="btn btn-ghost" id="btn-cancel">Cancel</button>',
        '</div>',
      ].join('');

      document.getElementById('btn-cancel').addEventListener('click', function () {
        renderBookDetail(book, currentList, db);
      });

      document.getElementById('btn-confirm').addEventListener('click', function () {
        var select = document.getElementById('move-select');
        var target = select.value;
        var btn    = document.getElementById('btn-confirm');
        btn.disabled    = true;
        btn.textContent = 'Saving\u2026';

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
  // HELPER: empty panel HTML
  // =============================================================

  function emptyPanel(listId, message) {
    var addBtn = listId
      ? '<button class="btn btn-primary empty-add-btn" data-list="' + listId + '">' + ICON_PLUS + ' Add a book</button>'
      : '';
    return [
      '<div class="empty-state">',
        ICON_BOOK_OPEN,
        '<p>' + escapeHtml(message) + '</p>',
        addBtn,
      '</div>',
    ].join('');
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
