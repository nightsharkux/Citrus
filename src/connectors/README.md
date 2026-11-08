# Connectors

Adapters to external university systems. Each one is a small factory:

```js
createXConnector({ baseUrl, fetchImpl }) -> { configured(), verify(credential), …read methods }
```

- `moodle.js` covers Moodle Web Services (REST/JSON). Users link their own account with a personal token from Moodle → Preferences → Security keys. CampusOS never stores Moodle passwords, and tokens are encrypted at rest (`secretBox`).

Adding a connector:

1. Create `<system>.js` here, with its configuration read in `src/config.js`.
2. Build it in `src/app.js` and add it to `deps`.
3. Add user-facing routes in `src/modules/integrations/routes.js`.
4. Add a test that uses a mock server (see `tests/account-migrations.test.js` for the Moodle example).

Only connect systems your university has approved. Never scrape authenticated pages.
