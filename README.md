# Little Library

A small self-hosted web app for cataloguing a [little free library](https://en.wikipedia.org/wiki/Little_Free_Library) — the kind that lives in a box at the end of a driveway.

Books are scanned by ISBN with a phone, land in a Google Sheet, and appear here with covers and metadata. You can browse them, correct anything the internet got wrong, and keep track of which books in a series you're still missing.

It runs in a container on a machine you own. Nothing needs to be started or stopped, and nothing runs on your laptop.

## Status

Early. The scaffold works; features are being built out. See the issue tracker.

## How it fits together

```
phone (ISBN scan)  ->  Google Sheet  ->  this app  ->  SQLite
                                            |
                                        your browser
```

The Sheet is only an inbox. Once a book is imported, this app's database is the
source of truth — that's what lets you edit a book's details and have the change
survive the next import.

## Running it locally

Requires Node 24 or newer. No build step, no bundler.

```sh
npm install
npm start
```

Then open <http://localhost:8080/health>.

It will start with no configuration at all — you just won't be able to import
from a Sheet or look up metadata until you add credentials.

## Configuration

Copy the example and fill it in:

```sh
cp config.example.json config.json
```

| Key | Purpose |
|---|---|
| `port` | HTTP port. Default 8080. |
| `databasePath` | Where the SQLite file lives. Mount this as a volume in a container. |
| `sheet.gatewayUrl` | Apps Script web app URL for the sheet the scanner writes to. |
| `sheet.gatewayToken` | Shared token gating that endpoint. |
| `googleBooks.apiKey` | Google Books API key. Required — anonymous calls hit a shared quota and start returning `429`. |
| `library.name` | Shown in the page header. |

Every key can also be set by environment variable, which is how the container is
configured: `PORT`, `DATABASE_PATH`, `SHEET_GATEWAY_URL`, `SHEET_GATEWAY_TOKEN`,
`GOOGLE_BOOKS_KEY`, `LIBRARY_NAME`. Environment wins over the file.

**`config.json` is gitignored and must stay that way.** The gateway URL is itself
a credential: anyone holding it can read and append to the sheet.

## Tests

```sh
npm test
```

Plain `node:test`, no framework. Every feature ships with tests and they pass
before the pull request opens.

## Contributing

Work happens on branches named after the tracking issue (`vie-NN-short-slug`) and
lands on `main` through pull requests. Nothing is committed to `main` directly.

## Privacy

This repo contains no real library data. The sample dataset is synthetic. If you
run your own instance, your catalogue lives in your database and stays there —
a catalogue of books is also a description of a home, so it's worth keeping that
in mind before pointing anything public at it.

## Licence

[Apache 2.0](LICENSE).

## Working with a real library locally

The repo ships synthetic sample data only. To develop against a real catalogue
exported from the original static generator:

```sh
npm run import -- /path/to/books.json   # one-off, into the configured database
npm start                               # serves that database
```

`npm run demo` starts against the synthetic sample instead, with nothing
persisted — that's what tests and CI use.

Real data stays local: `books.json`, `*.db` and `data/` are all gitignored, and
commits contain sample data only. A catalogue of books is also a description of
a home, so it does not belong in a public repo.
