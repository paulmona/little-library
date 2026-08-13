import Fastify from 'fastify';

import { loadConfig, describeCapabilities } from './config.js';

export function buildServer(config = loadConfig()) {
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    status: 'ok',
    library: config.library.name,
    capabilities: describeCapabilities(config),
  }));

  return app;
}

// Only listen when run directly, so tests can build a server without binding a port.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = buildServer(config);
  const capabilities = describeCapabilities(config);

  for (const [name, available] of Object.entries(capabilities)) {
    if (!available) {
      console.warn(`[little-library] ${name} unavailable - missing configuration`);
    }
  }

  app
    .listen({ port: config.port, host: '0.0.0.0' })
    .then(() => console.log(`[little-library] listening on ${config.port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
