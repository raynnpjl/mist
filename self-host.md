# Self-host Mist

## Requirements

- **Node.js 22.17.0+** and npm.
- **Neon PostgreSQL** for accounts and saved preferences.
- **Upstash Redis** with an HTTPS REST URL and read/write REST token for discovery caches.
- **FFmpeg**, including `ffprobe`, for full media inspection and unlabelled ad detection. The Docker image includes it.
- Provider endpoints in a local `config.json`, created from [`configexample.json`](configexample.json), plus a TMDB v3 API key entered through the workspace.

## 1. Install and configure

From the repository root:

```sh
npm ci
```

Create `config.json` in the repository root before running `npm run build`, starting Mist or building the Docker image:

```sh
cp -n configexample.json config.json
```

The `-n` flag preserves an existing `config.json`. Edit your local copy before use:

- Replace the example API URLs and provider names with your provider settings. API providers support optional ordered `backup_apis`; remove that field if you have no backups.
- Rename `web_site.mkvexample` to `web_site.mkvdrama`, then set its name and HTTPS origin for MKVDrama. Websites require a dedicated scraper; an arbitrary website URL will not work.

Keep your provider configuration local. Mist requires a valid `config.json` at startup, and the Dockerfile copies it during the build. After changing provider settings, restart Mist or rebuild your container deployment.

Create `.env` with your storage credentials and a stable encryption key:

```dotenv
DATABASE_URL=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
MIST_ENCRYPTION_KEY=
```

Generate the encryption key once and paste the output into `MIST_ENCRYPTION_KEY`:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use Upstash's **REST** credentials, rather than a `redis://` connection URL. Keep `.env` private and retain the same encryption key across deployments; existing TMDB credentials depend on it. Use separate databases and secrets for development or preview instances.

## 2. Create an account

Initialize the Neon table once, then generate an access key:

```sh
npm run build
npm run access-key -- init
npm run access-key -- create
```

Save the generated key: it is shown only once. Each key owns its own TMDB connection and preferences. Create or revoke accounts without restarting Mist:

```sh
npm run access-key -- list
npm run access-key -- revoke <account-id>
```

## 3. Run Mist

For development:

```sh
npm run dev
```

For production, after building:

```sh
npm start
```

Or, after configuring `.env` and creating your account, run with Docker:

```sh
docker compose up -d --build
```

Open **http://localhost:7000/configure** and follow [Install](README.md#install). For remote use, serve Mist over HTTPS and use that deployment's `/configure` page. Keep access keys and private manifest URLs confidential.
