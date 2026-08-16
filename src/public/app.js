const shell = document.getElementById('shell');
const gridView = document.getElementById('grid-view');
const detailView = document.getElementById('detail-view');
const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');

const genreSelect = document.getElementById('f-genre');
const seriesSelect = document.getElementById('f-series');
const ageInput = document.getElementById('f-age');
const clearButton = document.getElementById('clear-filters');
const pageSizeSelect = document.getElementById('page-size');
const pageSizeCustom = document.getElementById('page-size-custom');
const pager = document.getElementById('pager');

const SORT_KEY = 'little-library.sort';
const SCROLL_KEY = 'little-library.scroll';
const PAGE_SIZE_KEY = 'little-library.pageSize';
const FILTER_KEY = 'little-library.filters';

let allBooks = [];
let page = 1;

/** Stored as a number, or the string 'all'. */
function pageSize() {
  const stored = localStorage.getItem(PAGE_SIZE_KEY) ?? '50';
  if (stored === 'all') return 'all';
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function pagerMarkup(totalPages) {
  if (totalPages <= 1) return '';

  // Window of pages around the current one, so 643 books doesn't render 13 buttons.
  const nums = new Set([1, totalPages, page, page - 1, page + 1]);
  const shown = [...nums].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);

  let html = `<button type="button" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>&larr;</button>`;
  let previous = 0;
  for (const n of shown) {
    if (n - previous > 1) html += '<span class="gap">…</span>';
    html += `<button type="button" data-page="${n}" ${n === page ? 'aria-current="page"' : ''}>${n}</button>`;
    previous = n;
  }
  html += `<button type="button" data-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>&rarr;</button>`;
  return html;
}

/** Titles, authors and descriptions come from third-party APIs. Never trust them as HTML. */
function text(value) {
  const node = document.createElement('span');
  node.textContent = value ?? '';
  return node.innerHTML;
}

function ageLabel(book) {
  if (book.age_min && book.age_max) return `Ages ${book.age_min}–${book.age_max}`;
  if (book.age_min) return `Ages ${book.age_min}+`;
  return null;
}

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function coverMarkup(book, { large = false } = {}) {
  if (book.cover_url) return `<img src="${text(book.cover_url)}" alt="" ${large ? '' : 'loading="lazy"'}>`;
  return `
    <div class="cover-spine"></div>
    <div class="cover-placeholder">
      <div>&#128214;</div>
      <div class="ct">${text(book.title ?? 'Not yet identified')}</div>
    </div>`;
}


/**
 * Series state on the card. Karen's actual need, corrected twice in the
 * original conversation: while scrolling she wants to notice that a book
 * belongs to a must-read-in-order series at all, so she does not gift book 4
 * of something. It is not about highlighting what she is missing.
 *
 * Never colour alone — every state carries words too.
 */
function seriesBadge(book) {
  if (!book.series) {
    // Books grouped without a story arc still show their series name quietly.
    return book.series_name
      ? `<div class="card-series">${text(book.series_name)}${book.series_position ? ` &middot; #${text(book.series_position)}` : ''}</div>`
      : '';
  }

  const { name, total, readInOrder, completeness } = book.series;
  const position = book.series_position;
  const place = position && total ? `#${position} of ${total}` : position ? `#${position}` : '';

  if (!readInOrder) {
    return `<div class="card-series">${text(name)}${place ? ` &middot; ${text(place)}` : ''}</div>`;
  }

  const states = {
    'no-first': ['warn', 'Start with book 1'],
    started: ['part', 'Read in order'],
    complete: ['done', 'Complete series'],
    unknown: ['part', 'Read in order'],
  };
  const [cls, label] = states[completeness] ?? states.unknown;

  return `
    <div class="card-series">${text(name)}${place ? ` &middot; ${text(place)}` : ''}</div>
    <div class="series-flag ${cls}">${text(label)}</div>`;
}

// ---------------------------------------------------------------- grid view

function cardMarkup(book) {
  const tags = [];
  if (book.genre) tags.push(`<span class="tag tag-genre">${text(book.genre)}</span>`);
  const age = ageLabel(book);
  if (age) tags.push(`<span class="tag tag-age">${text(age)}</span>`);
  for (const topic of (book.topics ?? []).slice(0, 2)) {
    tags.push(`<span class="tag tag-theme">${text(topic)}</span>`);
  }

  const series = seriesBadge(book);

  return `
    <a class="book-card" href="/book/${encodeURIComponent(book.isbn)}" data-isbn="${text(book.isbn)}">
      <div class="cover">${coverMarkup(book)}</div>
      <div class="card-body">
        <div class="card-title">${text(book.title ?? 'Not yet identified')}</div>
        ${book.author
          ? `<div class="card-author">${text(book.author)}</div>`
          : `<div class="card-unknown">ISBN ${text(book.isbn)}</div>`}
        ${series}
        <div class="tags">${tags.join('')}</div>
      </div>
    </a>`;
}

/**
 * Filters stack: each narrows what the others left, and all of them combine
 * with the search box. At 643 books search alone isn't enough to answer
 * "what have I got for a nine-year-old that isn't part of a series".
 */
function matches(book, { query, genre, series, age }) {
  if (query) {
    const haystack = `${book.title ?? ''} ${book.author ?? ''} ${book.series_name ?? ''} ${(book.topics ?? []).join(' ')}`;
    if (!haystack.toLowerCase().includes(query)) return false;
  }

  if (genre && book.genre !== genre) return false;

  if (age !== null) {
    // A book with no age range can't be confirmed suitable, so it is excluded
    // rather than assumed. The result count makes that visible.
    if (book.age_min === null && book.age_max === null) return false;
    if (book.age_min !== null && age < book.age_min) return false;
    if (book.age_max !== null && age > book.age_max) return false;
  }

  if (series) {
    const inSeries = Boolean(book.series_id);
    if (series === 'in' && !inSeries) return false;
    if (series === 'standalone' && inSeries) return false;
    if (series === 'order' && !book.series?.readInOrder) return false;
    if (series === 'nofirst' && book.series?.completeness !== 'no-first') return false;
  }

  return true;
}

function currentFilters() {
  const age = ageInput.value.trim();
  return {
    query: searchInput.value.trim().toLowerCase(),
    genre: genreSelect.value,
    series: seriesSelect.value,
    age: age === '' ? null : Number(age),
  };
}

function saveFilters() {
  const { genre, series, age } = currentFilters();
  localStorage.setItem(FILTER_KEY, JSON.stringify({ genre, series, age }));
}

function restoreFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? '{}');
    genreSelect.value = saved.genre ?? '';
    seriesSelect.value = saved.series ?? '';
    ageInput.value = saved.age ?? '';
  } catch {
    // A corrupt preference is not worth failing over.
  }
}

/**
 * Genres actually present, ordered by how many books carry them.
 *
 * The genre inference falls back to "first subject line", which produces a long
 * tail of junk — 65 genres with exactly one book each, things like "Apartment
 * Houses". Alphabetical order would bury Fantasy and Mystery under that noise,
 * so the useful ones lead and the counts make the tail obviously trivial.
 */
function populateGenres() {
  const chosen = genreSelect.value;

  const counts = new Map();
  for (const book of allBooks) {
    if (book.genre) counts.set(book.genre, (counts.get(book.genre) ?? 0) + 1);
  }

  const genres = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  genreSelect.innerHTML = '<option value="">All genres</option>'
    + genres.map(([g, n]) => `<option value="${text(g)}">${text(g)} (${n})</option>`).join('');

  // Keep the selection if it still exists after a data refresh.
  genreSelect.value = counts.has(chosen) ? chosen : '';
}

function renderGrid() {
  const filters = currentFilters();
  const active = Boolean(filters.query || filters.genre || filters.series || filters.age !== null);
  clearButton.hidden = !active;

  // Filtering spans the whole library, not just the visible page.
  const visible = allBooks.filter((book) => matches(book, filters));

  const size = pageSize();
  const perPage = size === 'all' ? Math.max(visible.length, 1) : size;
  const totalPages = Math.max(1, Math.ceil(visible.length / perPage));
  if (page > totalPages) page = totalPages;

  const start = (page - 1) * perPage;
  const pageBooks = visible.slice(start, start + perPage);

  document.getElementById('stat-shown').textContent = visible.length;
  document.getElementById('stat-genres').textContent =
    new Set(visible.map((b) => b.genre).filter(Boolean)).size;
  document.getElementById('stat-series').textContent =
    new Set(visible.map((b) => b.series_id).filter(Boolean)).size;

  const scope = active
    ? `${visible.length} of ${allBooks.length} books`
    : `${allBooks.length} books`;
  const range = visible.length && size !== 'all' && totalPages > 1
    ? ` — showing ${start + 1}–${start + pageBooks.length}`
    : '';
  document.getElementById('results-meta').textContent = scope + range;

  grid.innerHTML = pageBooks.length
    ? pageBooks.map(cardMarkup).join('')
    : `<div class="empty-state"><div class="big">&#128269;</div>
       <div>Nothing matches.</div>
       <div><button class="btn btn-quiet" type="button" data-action="clear">Clear filters</button></div>
       </div>`;

  pager.innerHTML = pagerMarkup(totalPages);
  pager.hidden = pager.innerHTML === '';
}

// -------------------------------------------------------------- detail view

function seriesMarkup(series, currentIsbn) {
  if (!series) {
    return `
      <section class="detail-block">
        <h2>Series</h2>
        <p class="series-meta">Not part of a series.</p>
        <button class="btn btn-quiet" data-action="add-series">Add to a series</button>
      </section>`;
  }

  const owned = series.books.map((book) => {
    const here = book.isbn === currentIsbn;
    const position = book.series_position ?? '?';
    return `<li class="series-entry owned${here ? ' current' : ''}">
      <span class="mark">&#10003;</span>
      <span class="pos">${text(position)}.</span>
      ${here ? text(book.title ?? book.isbn) : `<a href="/book/${encodeURIComponent(book.isbn)}">${text(book.title ?? book.isbn)}</a>`}
    </li>`;
  }).join('');

  // Missing entries are positions, not titles — nobody told us what book 3 is
  // called. The number is still what is printed on a spine at a garage sale.
  const missing = series.missingPositions.map((position) => `
    <li class="series-entry missing">
      <span class="mark">&mdash;</span>
      <span class="pos">${text(position)}.</span>
      <em>not in the library</em>
    </li>`).join('');

  const count = series.total_known
    ? `${series.owned} of ${series.total_known}`
    : `${series.owned} in the library, total unknown`;

  return `
    <section class="detail-block">
      <h2>${text(series.name)}</h2>
      <p class="series-meta">
        ${text(count)}
        ${series.must_read_in_order ? '<span class="tag tag-order">Read in order</span>' : ''}
        ${series.unplaced ? `<span class="tag tag-theme">${text(series.unplaced)} unplaced</span>` : ''}
      </p>
      <ul class="series-list">${owned}${missing}</ul>
      <div class="detail-actions">
        <button class="btn btn-quiet" data-action="add-series">Edit series</button>
        <button class="btn btn-quiet" data-action="leave-series">Remove from series</button>
      </div>
    </section>`;
}

function detailMarkup(book) {
  const facts = [
    ['Author', book.author],
    ['Genre', book.genre],
    ['Ages', ageLabel(book)],
    ['Published', book.year],
    ['Pages', book.page_count],
    ['ISBN', book.isbn],
    ['Added', formatDate(book.added_at)],
    ['Last edited', formatDate(book.edited_at)],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');

  const topics = (book.topics ?? []).map((t) => `<span class="tag tag-theme">${text(t)}</span>`).join('');

  return `
    <a class="back" href="/">&larr; All books</a>
    <div class="detail">
      <div class="detail-cover">${coverMarkup(book, { large: true })}</div>
      <div class="detail-main">
        <h1>${text(book.title ?? 'Not yet identified')}</h1>
        ${book.title ? '' : '<p class="card-unknown">This book was scanned but never looked up.</p>'}
        ${topics ? `<div class="tags">${topics}</div>` : ''}
        ${book.description ? `<p class="description">${text(book.description)}</p>` : ''}
        <dl class="facts">
          ${facts.map(([label, value]) => `<dt>${text(label)}</dt><dd>${text(value)}</dd>`).join('')}
        </dl>
        <div class="detail-actions">
          <button class="btn" data-action="edit">&#9998; Edit</button>
          <button class="btn btn-quiet" data-action="remove">Remove from library</button>
        </div>
      </div>
    </div>
    ${seriesMarkup(book.series, book.isbn)}`;
}

async function showDetail(isbn) {
  gridView.hidden = true;
  detailView.hidden = false;
  detailView.innerHTML = '<div class="empty-state">Loading…</div>';

  const res = await fetch(`/api/books/${encodeURIComponent(isbn)}`);
  if (!res.ok) {
    detailView.innerHTML = '<a class="back" href="/">&larr; All books</a><div class="empty-state"><div class="big">&#128533;</div><div>No such book.</div></div>';
    return;
  }

  const book = await res.json();
  currentBook = book;
  detailView.innerHTML = detailMarkup(book);
  document.title = book.title ?? 'Little Library';
  window.scrollTo(0, 0);
}

function showGrid() {
  detailView.hidden = true;
  gridView.hidden = false;
  renderGrid();
  // Coming back from a book should land where you left off, not at the top.
  const saved = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
  window.scrollTo(0, saved);
}


// --------------------------------------------------------------- edit / remove

let currentBook = null;

const EDITABLE = [
  ['title', 'Title', 'text'],
  ['author', 'Author', 'text'],
  ['genre', 'Genre', 'text'],
  ['age_min', 'Youngest age', 'number'],
  ['age_max', 'Oldest age', 'number'],
  ['year', 'Year published', 'number'],
  ['page_count', 'Pages', 'number'],
];

function editMarkup(book) {
  const fields = EDITABLE.map(([name, label, type]) => `
    <label class="field">
      <span>${text(label)}</span>
      <input name="${name}" type="${type}" value="${text(book[name] ?? '')}">
    </label>`).join('');

  return `
    <a class="back" href="/">&larr; All books</a>
    <form class="edit-form" id="edit-form">
      <h1>Edit</h1>
      <p class="edit-note">Anything you change here is kept. Automatic updates will not overwrite it.</p>
      ${fields}
      <label class="field">
        <span>Topics</span>
        <input name="topics" type="text" value="${text((book.topics ?? []).join(', '))}">
        <small>Separated by commas</small>
      </label>
      <label class="field">
        <span>Description</span>
        <textarea name="description" rows="6">${text(book.description ?? '')}</textarea>
      </label>
      <div class="detail-actions">
        <button class="btn" type="submit">Save</button>
        <button class="btn btn-quiet" type="button" data-action="cancel">Cancel</button>
      </div>
    </form>`;
}

function showEdit() {
  detailView.innerHTML = editMarkup(currentBook);
  window.scrollTo(0, 0);

  document.getElementById('edit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);

    const payload = {};
    for (const [name, , type] of EDITABLE) {
      const raw = form.get(name).trim();
      // An emptied field means "unset", not "zero" and not "empty string".
      payload[name] = raw === '' ? null : (type === 'number' ? Number(raw) : raw);
    }
    payload.topics = form.get('topics').split(',').map((t) => t.trim()).filter(Boolean);
    payload.description = form.get('description').trim() || null;

    const res = await fetch(`/api/books/${encodeURIComponent(currentBook.isbn)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      alert('Could not save that change.');
      return;
    }

    await showDetail(currentBook.isbn);
    await refreshBooks();
  });
}

async function removeCurrent() {
  // One tap is too easy on a phone, so confirm - and still offer undo after.
  if (!window.confirm(`Remove “${currentBook.title ?? currentBook.isbn}” from the library?`)) return;

  const isbn = currentBook.isbn;
  const res = await fetch(`/api/books/${encodeURIComponent(isbn)}`, { method: 'DELETE' });
  if (!res.ok) {
    alert('Could not remove that book.');
    return;
  }

  await refreshBooks();
  window.history.pushState({}, '', '/');
  showGrid();
  showUndo(isbn);
}

function showUndo(isbn) {
  const bar = document.createElement('div');
  bar.className = 'undo-bar';
  bar.innerHTML = '<span>Book removed.</span> <button class="btn btn-quiet" type="button">Undo</button>';
  bar.querySelector('button').addEventListener('click', async () => {
    await fetch(`/api/books/${encodeURIComponent(isbn)}/restore`, { method: 'POST' });
    await refreshBooks();
    renderGrid();
    bar.remove();
  });
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 10000);
}


// ------------------------------------------------------------ series builder

/**
 * Series are built by hand. Karen names one, says how many books are in it
 * (she looks that up herself), then ticks which of her books by this author
 * belong. Nothing is guessed — see VIE-52 for why automation was dropped.
 */
async function showSeriesBuilder() {
  const isbn = currentBook.isbn;
  const [seriesRes, sameAuthorRes] = await Promise.all([
    fetch('/api/series'),
    fetch(`/api/books/${encodeURIComponent(isbn)}/same-author`),
  ]);

  const { series } = await seriesRes.json();
  const { books } = await sameAuthorRes.json();

  const options = series
    .map((s) => `<option value="${s.id}" ${currentBook.series?.id === s.id ? 'selected' : ''}>${text(s.name)} (${s.owned})</option>`)
    .join('');

  const rows = books.map((book) => {
    const checked = book.isbn === isbn || book.series_id === currentBook.series?.id;
    return `
      <li class="pick">
        <label>
          <input type="checkbox" name="pick" value="${text(book.isbn)}" ${checked ? 'checked' : ''}>
          <span class="pick-title">${text(book.title ?? book.isbn)}</span>
        </label>
        <input class="pick-pos" type="number" min="1" max="999" placeholder="#"
               data-isbn="${text(book.isbn)}" value="${book.suggestedPosition ?? ''}">
      </li>`;
  }).join('');

  detailView.innerHTML = `
    <a class="back" href="/book/${encodeURIComponent(isbn)}">&larr; Back to the book</a>
    <form class="edit-form" id="series-form">
      <h1>Series</h1>
      <p class="edit-note">
        Pick an existing series or start a new one, then tick which of these books belong.
        Only books by <strong>${text(currentBook.author ?? 'this author')}</strong> are shown.
      </p>

      <label class="field">
        <span>Series</span>
        <select name="seriesId" id="series-select">
          <option value="new">— Create a new series —</option>
          ${options}
        </select>
      </label>

      <div id="new-series-fields">
        <label class="field">
          <span>Name</span>
          <input name="name" type="text" placeholder="e.g. Harry Potter">
        </label>
        <label class="field">
          <span>How many books in the series?</span>
          <input name="totalKnown" type="number" min="1" max="999" placeholder="e.g. 7">
          <small>Look this up yourself — leave blank if you don't know.</small>
        </label>
      </div>

      <label class="field checkbox-field">
        <input name="mustReadInOrder" type="checkbox">
        <span>These must be read in order</span>
      </label>

      <div class="field">
        <span>Books by this author</span>
        <ul class="pick-list">${rows || '<li class="pick"><em>No other books by this author.</em></li>'}</ul>
        <small>The number is the book's place in the series. Leave blank if you're not sure.</small>
      </div>

      <div class="detail-actions">
        <button class="btn" type="submit">Save</button>
        <button class="btn btn-quiet" type="button" data-action="cancel">Cancel</button>
      </div>
    </form>`;

  const select = document.getElementById('series-select');
  const newFields = document.getElementById('new-series-fields');
  const syncMode = () => { newFields.hidden = select.value !== 'new'; };
  select.addEventListener('change', syncMode);
  syncMode();

  document.getElementById('series-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);

    let seriesId = form.get('seriesId');
    const mustReadInOrder = form.get('mustReadInOrder') === 'on';

    if (seriesId === 'new') {
      const name = (form.get('name') ?? '').trim();
      if (!name) { alert('Give the series a name.'); return; }

      const totalRaw = (form.get('totalKnown') ?? '').trim();
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, totalKnown: totalRaw ? Number(totalRaw) : null, mustReadInOrder }),
      });

      if (!res.ok) { alert((await res.json()).error ?? 'Could not create that series.'); return; }
      seriesId = (await res.json()).id;
    } else {
      await fetch(`/api/series/${seriesId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mustReadInOrder }),
      });
    }

    const picked = [...event.target.querySelectorAll('input[name="pick"]:checked')].map((input) => {
      const position = event.target.querySelector(`.pick-pos[data-isbn="${input.value}"]`)?.value;
      return { isbn: input.value, position: position ? Number(position) : null };
    });

    if (picked.length) {
      await fetch(`/api/series/${seriesId}/books`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ books: picked }),
      });
    }

    await refreshBooks();
    await showDetail(isbn);
  });
}

async function leaveSeries() {
  const seriesId = currentBook.series?.id;
  if (!seriesId) return;
  if (!window.confirm(`Remove "${currentBook.title ?? currentBook.isbn}" from ${currentBook.series.name}?`)) return;

  await fetch(`/api/series/${seriesId}/books/${encodeURIComponent(currentBook.isbn)}`, { method: 'DELETE' });
  await refreshBooks();
  await showDetail(currentBook.isbn);
}

detailView.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'edit') showEdit();
  if (action === 'cancel') showDetail(currentBook.isbn);
  if (action === 'remove') removeCurrent();
  if (action === 'add-series') showSeriesBuilder();
  if (action === 'leave-series') leaveSeries();
});


// --------------------------------------------------------- missing books view

/**
 * The list Karen carries. Only series she has started, ordered by how close she
 * is to finishing, because a series needing one more book is the one worth
 * looking for at a sale.
 */
async function showMissing() {
  gridView.hidden = true;
  detailView.hidden = false;
  detailView.innerHTML = '<div class="empty-state">Loading…</div>';

  const { series } = await (await fetch('/api/missing')).json();

  if (!series.length) {
    detailView.innerHTML = `
      <a class="back" href="/">&larr; All books</a>
      <div class="empty-state"><div class="big">&#127881;</div>
      <div>Nothing missing from any series you've started.</div></div>`;
    return;
  }

  const blocks = series.map((s) => {
    const missing = s.missing.map((n) => `<span class="miss-num">${text(n)}</span>`).join('');
    const owned = s.books
      .filter((b) => b.position)
      .map((b) => `<li><span class="pos">${text(b.position)}.</span> ${text(b.title ?? b.isbn)}</li>`)
      .join('');

    return `
      <section class="missing-block">
        <h2>${text(s.name)}</h2>
        <p class="series-meta">
          have ${text(s.owned)} of ${text(s.total)}
          ${s.readInOrder ? '<span class="tag tag-order">Read in order</span>' : ''}
          ${!s.have.includes(1) ? '<span class="tag tag-warn">No book 1</span>' : ''}
        </p>
        <p class="miss-label">Missing</p>
        <div class="miss-nums">${missing}</div>
        <details><summary>${text(s.owned)} you have</summary><ul class="have-list">${owned}</ul></details>
      </section>`;
  }).join('');

  detailView.innerHTML = `
    <a class="back" href="/">&larr; All books</a>
    <h1 class="page-title">Books to look for</h1>
    <p class="edit-note">
      ${text(series.length)} series you've started. Numbers are the book's place in the series —
      that's what's printed on the spine.
    </p>
    ${blocks}`;
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ routing

function route() {
  const path = window.location.pathname;
  const match = path.match(/^\/book\/(.+)$/);

  if (match) showDetail(decodeURIComponent(match[1]));
  else if (path === '/missing') showMissing();
  else showGrid();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || link.origin !== window.location.origin) return;
  const known = link.pathname.startsWith('/book/') || link.pathname === '/' || link.pathname === '/missing';
  if (!known) return;

  event.preventDefault();
  if (link.pathname.startsWith('/book/')) {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  }
  window.history.pushState({}, '', link.pathname);
  route();
});

window.addEventListener('popstate', route);

// -------------------------------------------------------------------- boot

async function refreshBooks() {
  const sort = sortSelect.value;
  localStorage.setItem(SORT_KEY, sort);

  const [booksRes, statsRes] = await Promise.all([
    fetch(`/api/books?sort=${encodeURIComponent(sort)}`),
    fetch('/api/stats'),
  ]);

  allBooks = (await booksRes.json()).books;
  const stats = await statsRes.json();

  populateGenres();

  document.getElementById('library-name').textContent = stats.library;
  document.getElementById('stat-books').textContent = stats.books;
  document.getElementById('stat-authors').textContent = stats.authors;

  showEnrichProgress(stats);
}

const ENRICH_POLL_MS = 20_000;
let enrichPoll = null;

/**
 * While the background pass is still working through the library, say so.
 * Without this a book with no cover is ambiguous: it might have none, or it
 * might not have been looked up yet, and there is no way to tell by looking.
 */
function showEnrichProgress(stats) {
  const banner = document.getElementById('enrich-status');
  const pending = stats.pending ?? 0;

  if (pending === 0) {
    banner.hidden = true;
    if (enrichPoll) { clearInterval(enrichPoll); enrichPoll = null; }
    return;
  }

  const done = stats.books - pending;
  banner.hidden = false;
  banner.textContent =
    `Looking up book details — ${done} of ${stats.books} done. `
    + 'Covers and titles appear as they arrive; this page updates itself.';

  if (enrichPoll) return;
  enrichPoll = setInterval(async () => {
    // Only while the grid is on screen. Refreshing under an open edit form
    // would throw away what someone is part way through typing.
    if (gridView.hidden) return;
    await refreshBooks();
    renderGrid();
  }, ENRICH_POLL_MS);
}

async function load() {
  await refreshBooks();
  route();
}

pager.addEventListener('click', (event) => {
  const target = event.target.closest('button[data-page]');
  if (!target || target.disabled) return;
  page = Number(target.dataset.page);
  renderGrid();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function applyPageSize(value) {
  localStorage.setItem(PAGE_SIZE_KEY, String(value));
  page = 1;
  renderGrid();
}

pageSizeSelect.addEventListener('change', () => {
  const value = pageSizeSelect.value;
  pageSizeCustom.hidden = value !== 'custom';

  if (value === 'custom') {
    pageSizeCustom.value = pageSize() === 'all' ? 50 : pageSize();
    pageSizeCustom.focus();
    return;
  }
  applyPageSize(value);
});

pageSizeCustom.addEventListener('change', () => {
  const n = Number(pageSizeCustom.value);
  if (Number.isFinite(n) && n > 0) applyPageSize(n);
});

// Restore the stored size, falling back to Custom when it isn't one of the presets.
{
  const stored = String(pageSize());
  const preset = [...pageSizeSelect.options].some((o) => o.value === stored);
  pageSizeSelect.value = preset ? stored : 'custom';
  if (!preset) {
    pageSizeCustom.hidden = false;
    pageSizeCustom.value = stored;
  }
}

sortSelect.value = localStorage.getItem(SORT_KEY) ?? 'title';
sortSelect.addEventListener('change', () => { page = 1; load(); });
// A new search should start at the first page, not strand you on page 7 of 2.
searchInput.addEventListener('input', () => { page = 1; renderGrid(); });

function onFilterChange() {
  page = 1;
  saveFilters();
  renderGrid();
}

genreSelect.addEventListener('change', onFilterChange);
seriesSelect.addEventListener('change', onFilterChange);
ageInput.addEventListener('input', onFilterChange);

function clearFilters() {
  searchInput.value = '';
  genreSelect.value = '';
  seriesSelect.value = '';
  ageInput.value = '';
  onFilterChange();
}

clearButton.addEventListener('click', clearFilters);
// Getting stuck on an empty grid with no obvious way out is the failure to avoid.
grid.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="clear"]')) clearFilters();
});

restoreFilters();

load().catch((err) => {
  shell.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>Could not reach the library.</div></div>';
  console.error(err);
});
