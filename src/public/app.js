const shell = document.getElementById('shell');
const gridView = document.getElementById('grid-view');
const detailView = document.getElementById('detail-view');
const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');

const SORT_KEY = 'little-library.sort';
const SCROLL_KEY = 'little-library.scroll';

let allBooks = [];

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
  const visible = allBooks.filter((book) => matches(book, query));

  document.getElementById('stat-shown').textContent = visible.length;
  document.getElementById('results-meta').textContent = query
    ? `${visible.length} of ${allBooks.length} books match “${query}”`
    : `${allBooks.length} books`;

  grid.innerHTML = visible.length
    ? visible.map(cardMarkup).join('')
    : '<div class="empty-state"><div class="big">&#128269;</div><div>Nothing matches that search.</div></div>';
}

// -------------------------------------------------------------- detail view

function seriesMarkup(series, currentIsbn) {
  if (!series) return '';

  const entries = series.entries.map((entry) => {
    const owned = Boolean(entry.isbn);
    const here = entry.isbn === currentIsbn;
    const cls = `series-entry ${owned ? 'owned' : 'missing'}${here ? ' current' : ''}`;
    const mark = owned ? '&#10003;' : '&mdash;';
    return `<li class="${cls}"><span class="mark">${mark}</span> <span class="pos">${text(entry.position)}.</span> ${text(entry.title)}</li>`;
  }).join('');

  const owned = series.entries.filter((e) => e.isbn).length;
  // Never present a total we don't actually know.
  const count = series.totalKnown
    ? `${owned} of ${series.totalKnown}`
    : `${owned} of an unknown number`;

  return `
    <section class="detail-block">
      <h2>${text(series.name)}</h2>
      <p class="series-meta">
        ${text(count)}
        ${series.mustReadInOrder ? '<span class="tag tag-order">Read in order</span>' : ''}
      </p>
      <ul class="series-list">${entries}</ul>
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

async function load() {
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

  route();
}

sortSelect.value = localStorage.getItem(SORT_KEY) ?? 'title';
sortSelect.addEventListener('change', () => load());
searchInput.addEventListener('input', renderGrid);

load().catch((err) => {
  shell.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>Could not reach the library.</div></div>';
  console.error(err);
});
