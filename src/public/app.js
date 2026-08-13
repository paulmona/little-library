const shell = document.getElementById('shell');
const gridView = document.getElementById('grid-view');
const detailView = document.getElementById('detail-view');
const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');

const pageSizeSelect = document.getElementById('page-size');
const pageSizeCustom = document.getElementById('page-size-custom');
const pager = document.getElementById('pager');

const SORT_KEY = 'little-library.sort';
const SCROLL_KEY = 'little-library.scroll';
const PAGE_SIZE_KEY = 'little-library.pageSize';

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

// ---------------------------------------------------------------- grid view

function cardMarkup(book) {
  const tags = [];
  if (book.genre) tags.push(`<span class="tag tag-genre">${text(book.genre)}</span>`);
  const age = ageLabel(book);
  if (age) tags.push(`<span class="tag tag-age">${text(age)}</span>`);
  for (const topic of (book.topics ?? []).slice(0, 2)) {
    tags.push(`<span class="tag tag-theme">${text(topic)}</span>`);
  }

  const series = book.series_name
    ? `<div class="card-series">${text(book.series_name)}${book.series_position ? ` &middot; #${text(book.series_position)}` : ''}</div>`
    : '';

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

function matches(book, query) {
  if (!query) return true;
  return `${book.title ?? ''} ${book.author ?? ''} ${book.series_name ?? ''}`
    .toLowerCase()
    .includes(query);
}

function renderGrid() {
  const query = searchInput.value.trim().toLowerCase();
  // Search spans the whole library, not just the visible page.
  const visible = allBooks.filter((book) => matches(book, query));

  const size = pageSize();
  const perPage = size === 'all' ? Math.max(visible.length, 1) : size;
  const totalPages = Math.max(1, Math.ceil(visible.length / perPage));
  if (page > totalPages) page = totalPages;

  const start = (page - 1) * perPage;
  const pageBooks = visible.slice(start, start + perPage);

  document.getElementById('stat-shown').textContent = visible.length;

  const scope = query ? `${visible.length} of ${allBooks.length} books match “${query}”` : `${allBooks.length} books`;
  const range = visible.length && size !== 'all' && totalPages > 1
    ? ` — showing ${start + 1}–${start + pageBooks.length}`
    : '';
  document.getElementById('results-meta').textContent = scope + range;

  grid.innerHTML = pageBooks.length
    ? pageBooks.map(cardMarkup).join('')
    : '<div class="empty-state"><div class="big">&#128269;</div><div>Nothing matches that search.</div></div>';

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

// ------------------------------------------------------------------ routing

function route() {
  const match = window.location.pathname.match(/^\/book\/(.+)$/);
  if (match) showDetail(decodeURIComponent(match[1]));
  else showGrid();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || link.origin !== window.location.origin) return;
  if (!link.pathname.startsWith('/book/') && link.pathname !== '/') return;

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

  document.getElementById('library-name').textContent = stats.library;
  document.getElementById('stat-books').textContent = stats.books;
  document.getElementById('stat-authors').textContent = stats.authors;
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

load().catch((err) => {
  shell.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>Could not reach the library.</div></div>';
  console.error(err);
});
