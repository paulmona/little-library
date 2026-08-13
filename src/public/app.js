const grid = document.getElementById('grid');
const searchInput = document.getElementById('search');
const sortSelect = document.getElementById('sort');

let allBooks = [];

const SORT_KEY = 'little-library.sort';

/** Titles and authors come from third-party APIs, so never trust them as HTML. */
function text(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function coverMarkup(book) {
  if (book.cover_url) {
    return `<img src="${text(book.cover_url)}" alt="" loading="lazy">`;
  }
  // No jacket. Show the title rather than an empty grey box, so the card is
  // still identifiable — a real library has plenty of these.
  return `
    <div class="cover-spine"></div>
    <div class="cover-placeholder">
      <div>&#128214;</div>
      <div class="ct">${text(book.title ?? 'Not yet identified')}</div>
    </div>`;
}

function ageLabel(book) {
  if (book.age_min && book.age_max) return `Ages ${book.age_min}–${book.age_max}`;
  if (book.age_min) return `Ages ${book.age_min}+`;
  return null;
}

function cardMarkup(book) {
  // A book that has been scanned but never enriched is a real state, not an
  // error. Show the ISBN so it can be found and fixed rather than "undefined".
  const title = book.title ?? 'Not yet identified';
  const author = book.author ?? null;

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
    <a class="book-card" href="/api/books/${encodeURIComponent(book.isbn)}">
      <div class="cover">${coverMarkup(book)}</div>
      <div class="card-body">
        <div class="card-title">${text(title)}</div>
        ${author ? `<div class="card-author">${text(author)}</div>` : `<div class="card-unknown">ISBN ${text(book.isbn)}</div>`}
        ${series}
        <div class="tags">${tags.join('')}</div>
      </div>
    </a>`;
}

function matches(book, query) {
  if (!query) return true;
  const haystack = `${book.title ?? ''} ${book.author ?? ''} ${book.series_name ?? ''}`.toLowerCase();
  return haystack.includes(query);
}

function render() {
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

async function load() {
  const sort = sortSelect.value;
  localStorage.setItem(SORT_KEY, sort);

  const [booksRes, statsRes] = await Promise.all([
    fetch(`/api/books?sort=${encodeURIComponent(sort)}`),
    fetch('/api/stats'),
  ]);

  const { books } = await booksRes.json();
  const stats = await statsRes.json();

  allBooks = books;
  document.getElementById('library-name').textContent = stats.library;
  document.title = stats.library;
  document.getElementById('stat-books').textContent = stats.books;
  document.getElementById('stat-authors').textContent = stats.authors;

  render();
}

sortSelect.value = localStorage.getItem(SORT_KEY) ?? 'title';
sortSelect.addEventListener('change', load);
searchInput.addEventListener('input', render);

load().catch((err) => {
  grid.innerHTML = '<div class="empty-state"><div class="big">&#9888;</div><div>Could not reach the library.</div></div>';
  console.error(err);
});
