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

The app pulls new scans and looks up their titles, authors and covers on startup
and every fifteen minutes after that. Scanning a book is the only step: nothing
has to be run by hand, and a correction you make here is never overwritten by a
later lookup.

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

## Running it in Docker

Images are published to the GitHub Container Registry on every push to `main`:

```
ghcr.io/paulmona/little-library:latest
```

```sh
docker run -d --name little-library \
  -p 8080:8080 \
  -v /mnt/user/appdata/little-library:/data \
  -e LIBRARY_NAME="Little Library" \
  -e GOOGLE_BOOKS_KEY="..." \
  -e SHEET_GATEWAY_URL="..." \
  -e SHEET_GATEWAY_TOKEN="..." \
  ghcr.io/paulmona/little-library:latest
```

Nothing else is needed: one volume and the environment variables above. The
image contains no configuration, so a public image can never carry a real
deployment's credentials.

| | |
|---|---|
| Port | `8080` |
| Volume | `/data` — holds `library.db`, created on first run |
| Health | `GET /health`, also wired up as a container `HEALTHCHECK` |

The database is the only state. Back up `/data` and you have backed up the
library.

### Unraid

No custom template is required. Add a container with the generic template,
using the repository above, one port mapping, one path mapping to `/data`, and
the variables you need.

The container runs as the unprivileged `node` user (uid 1000), so the mapped
path has to be writable by it. On a stock `appdata` share owned by
`nobody:users` that means putting `--user 99:100` in Extra Parameters, which is
easier than changing ownership and keeps the app off root.

**Updating is not a restart.** Tags are mutable, so `latest` pointing at a new
image does not mean a running container will pick it up, and restarting it will
not either — it still has the old image locally. Use **Force Update** on the
container, or pull and then Edit → Apply. Skipping this looks exactly like a
deploy that silently did nothing, which is a day nobody gets back.

Confirm what you are actually running rather than assuming:

```sh
docker exec little-library cat /app/package.json | grep version
docker inspect little-library --format '{{.Config.Image}}'
```

### Rolling back

`latest` moves every time `main` builds, so the image it used to point at ends
up with no tag on it. Every build is therefore also tagged with its commit sha:

```
ghcr.io/paulmona/little-library:a1b2c3d
```

Pin that if you need to go back, or note the running digest before you update:

```sh
docker image inspect "$(docker inspect little-library --format '{{.Image}}')" \
  --format '{{json .RepoDigests}}'
```

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
