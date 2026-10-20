# proof

A local test bench for what [site-press](../site-press) produces. Drop in a `site.tar.gz` and proof unpacks it, installs, builds, runs it, signs you into its admin, and checks it: files, every page, link and image, and the admin itself.

Named for the test print you check before a press run.

## Install

```bash
cd ~/workspace/proof
npm install
npm link            # puts `proof` on your PATH
```

Node 20+. `npm install` pulls a native Postgres 16 for your platform (the `embedded-postgres` package), the same major version the generated sites deploy with. No Docker needed.

## Use

```bash
proof                                   # start the dashboard at http://localhost:4400
proof ~/Downloads/acme-site.tar.gz      # import, start, open it
proof acme-site.tar.gz acme-report.tar.gz --full
proof ~/workspace/clients/acme          # a site folder, run in place
```

When proof is already running, the CLI hands imports to it and exits. Ctrl-C in the terminal running proof stops every site and the database.

In the dashboard you can:

- **Drop** a site or report `.tar.gz` anywhere on the page, use **Choose folder** or **Choose tarball** (the native macOS picker), or paste a path.
- **Preview / Full**: Preview serves `site/seed.json` with no database, which is what site-press scores against. Full runs Postgres, migrations and the seed import, and creates an owner account.
- **Open admin** signs you in as the test owner, so you go straight to `/admin`.
- **Run checks** (see below).
- **Reset content** re-imports `seed.json` over the database (`npm run seed -- --replace`). **Wipe database** drops the database and uploads, so the next start is a first boot.
- **Rebuild** forces a Vite build. You rarely need it: proof rebuilds on start whenever the code changed. `seed.json` and `seed-media/` don't trigger a rebuild, because they're read at runtime.

Each site is served at `http://<slug>.localhost:4400`. Separate hostnames give each site its own cookies; on plain `localhost` ports, two admins would keep signing each other out. Chrome and Firefox resolve `*.localhost` on their own. If a browser doesn't, use the **Port** link, which goes straight to the site's own port.

## Checks

| Group | Runs when | What it looks at |
|---|---|---|
| Package | always | `site-press.json`, scripts, lockfile, leftover `__SITE_SLUG__` / `__SOURCE_URL__`, Dockerfile / compose / beachhead.json, `seed.json` (home page, duplicate paths, unknown block types, placeholder sections, contact forms with no fields), media rows vs files, images still hotlinked to the old site, images over 1.5 MB |
| Crawl | site running | every seed page returns 200 with blocks, every internal link / image / script / stylesheet on them, seed redirects, a real 404 for unknown paths, `sitemap.xml`, `robots.txt`, and any errors the server logged during the crawl |
| Admin | Full mode, running | sign-in, `/admin` loads, every seed page was imported, edit a heading and see it on the public page (then put it back), re-save every page (catches pages the client couldn't publish, and content the first Save would rewrite), upload / serve / delete an image, settings, and a contact-form submission that shows up under Form submissions |

The admin checks write to the test database: page revisions and one form submission per form. The contact form is rate-limited to 5 per 10 minutes, so running checks back to back can skip that check.

## Where things live

Everything proof owns is under `~/.proof` (set `PROOF_HOME` to move it):

```
registry.json   the site list: port, mode, test login, last checks
sites/<slug>/   unpacked tarballs (folders you import are run where they are)
reports/<slug>/ unpacked report tarballs, served at /reports/<slug>/
deps/<hash>/    one npm install per distinct package.json, symlinked into each site
media/<slug>/   uploads in Full mode
pg/             the embedded Postgres data dir (one database per site: proof_<slug>)
```

`rm -rf ~/.proof` starts over. For an imported folder, proof adds only a `node_modules` symlink and `dist/`, both already in the template's `.gitignore`. **Remove** takes the symlink back out.

Re-importing a tarball with the same slug keeps the site's port and login, but replaces the files and drops the database and uploads, so you're testing the new output from a clean first boot.

## Environment the sites get

Sites don't inherit your shell's environment. A stray `BREW_BUCKET_URL` or `DB_PASSWORD` there would send test uploads to the real bucket or point the site at the wrong database. Each site gets only `PATH`/`HOME`/`TMPDIR`/`LANG`/`TZ` plus:

| | Preview | Full |
|---|---|---|
| `NODE_ENV` | production | production |
| `PORT` | the site's port | the site's port |
| `SITE_PREVIEW_SEED` | 1 | |
| `DATABASE_URL` | | `proof_<slug>` on proof's Postgres |
| `ADMIN_BOOTSTRAP_TOKEN` | | random, per site |
| `MEDIA_DRIVER` / `MEDIA_DIR` | local / `site/seed-media` | local / `~/.proof/media/<slug>` |
| `COOKIE_SECURE` | 0 | 0 |

## Settings

| Env var | Default | |
|---|---|---|
| `PROOF_PORT` | 4400 | dashboard and `*.localhost` proxy |
| `PROOF_HOST` | 127.0.0.1 | the dashboard can start processes and delete folders, so it stays on loopback |
| `PROOF_HOME` | `~/.proof` | |
| `PROOF_PG_PORT` | 54329 | embedded Postgres |
| `PROOF_DATABASE_URL` | | use your own Postgres instead (a superuser URL, e.g. Postgres.app) |
| `PROOF_SITE_PORT_FROM` / `_TO` | 4501 / 4999 | ports handed to sites |

## What proof relies on in a site

The contract, so proof stays separate from site-press:

- `package.json` with the template's dependencies
- `node core/server/index.js` starts it, and it answers `GET /healthz`
- Vite builds: `vite build`, then `vite build --ssr core/client/entry-server.js --outDir dist/server`
- the env vars above, plus `/api/auth/state`, `/api/auth/bootstrap` and `/api/auth/login` with the `x-sp-csrf: 1` header
- `core/server/bin/seed.js --replace` for Reset content
- the admin API (`/api/admin/pages`, `/media`, `/settings`, `/submissions`) and `/api/forms/:blockId` for the admin checks

If the template changes any of these, update `server/runner.js` and `server/checks/admin.js`.

## Finder Quick Action (optional)

Right-click a tarball → Quick Actions → *Open in proof*:

1. Automator → New → Quick Action. Set "Workflow receives current" to **files or folders** in **Finder**.
2. Add **Run Shell Script**, set Pass input to **as arguments**, and paste: `"$(npm prefix -g)/bin/proof" "$@"`. This needs proof already running, or it starts one with no terminal to stop it from.
3. Save as "Open in proof".

## Develop

```bash
npm start              # same as `proof`
npm run dev:ui         # Vite dev server for the dashboard on :4399 (proxies /api to :4400)
npm run build          # rebuild ui/dist (also done automatically on first run)
```

```
bin/proof.js           CLI
server/index.js        dashboard API + SSE, host routing, shutdown
server/proxy.js        <slug>.localhost → site port, /__proof/login, stopped page
server/runner.js       start/stop/modes, site env, admin bootstrap, orphan cleanup
server/build.js        shared dependency cache, build fingerprint, Vite builds
server/importer.js     tarballs, folders, reports
server/postgres.js     embedded or external Postgres, database per site
server/checks/         package, crawl, admin
ui/                    Vue dashboard
```

## Not built yet

- **Docker mode.** Building the site's own `docker-compose.yml` would test the Dockerfile and compose file Beachhead runs. It's slower (an image build per change), so it fits as a "deploy check" button rather than the default way to run.
- **Side by side with the original.** Squarespace sends headers that stop it being framed, so comparing would need screenshots. That's what the site-press report already does; proof links to both instead.
- **Load from brew-bucket.** List `artifacts/site-press/<slug>/…` and pull the latest job without downloading by hand.
- **Restarting the sites that were running** when proof comes back up. Today every site starts stopped.

## Test fixtures

`test/fixtures/` holds two small fake site-press outputs made from the current template, for trying proof without running a job:

- `acme-studio-site.tar.gz` (plus `acme-studio-report.tar.gz`): clean. Every check passes except the missing-lockfile warning.
- `harbor-bakery-site.tar.gz`: broken on purpose. Two dead links, a contact form with no fields, a placeholder section, and an image hotlinked from squarespace-cdn.

```bash
proof test/fixtures/harbor-bakery-site.tar.gz --full
```
