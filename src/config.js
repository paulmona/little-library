import { readFileSync } from 'node:fs';

const DEFAULTS = {
  port: 8080,
  databasePath: './data/library.db',
  sheet: { gatewayUrl: '', gatewayToken: '' },
  googleBooks: { apiKey: '' },
  library: { name: 'Little Library' },
};

/**
 * Config comes from a JSON file, with environment variables overriding it.
 * Env wins so the container can be configured without mounting a file, which
 * is how it is deployed; the file exists so local development is pleasant.
 */
export function loadConfig({ path = process.env.CONFIG_PATH ?? './config.json' } = {}) {
  let fromFile = {};
  try {
    fromFile = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // A missing config file is normal in container deployments and in tests.
    // Anything else (malformed JSON, unreadable file) is worth failing on.
    if (err.code !== 'ENOENT') throw err;
  }

  return {
    port: Number(process.env.PORT ?? fromFile.port ?? DEFAULTS.port),
    databasePath: process.env.DATABASE_PATH ?? fromFile.databasePath ?? DEFAULTS.databasePath,
    sheet: {
      gatewayUrl: process.env.SHEET_GATEWAY_URL ?? fromFile.sheet?.gatewayUrl ?? '',
      gatewayToken: process.env.SHEET_GATEWAY_TOKEN ?? fromFile.sheet?.gatewayToken ?? '',
    },
    googleBooks: {
      apiKey: process.env.GOOGLE_BOOKS_KEY ?? fromFile.googleBooks?.apiKey ?? '',
    },
    library: {
      name: process.env.LIBRARY_NAME ?? fromFile.library?.name ?? DEFAULTS.library.name,
    },
  };
}

/**
 * Which optional integrations are usable with the config we have. The app must
 * start and serve the library without any of them - a missing Google Books key
 * degrades enrichment, it does not stop Karen reading her own catalogue.
 */
export function describeCapabilities(config) {
  return {
    sheetIngest: Boolean(config.sheet.gatewayUrl && config.sheet.gatewayToken),
    metadataLookup: Boolean(config.googleBooks.apiKey),
  };
}
