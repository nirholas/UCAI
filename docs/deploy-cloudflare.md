# Deploying to Cloudflare Pages

https://ucai.tech is served by Cloudflare Pages.

| | |
|---|---|
| Live site | https://ucai.tech and https://www.ucai.tech |
| Pages project | `ucai-tech` (https://ucai-tech.pages.dev) |
| Source | Jekyll site in `docs/` (GitHub Pages defaults, no Gemfile) |
| Build | `actions/jekyll-build-pages (source docs)` |
| Output directory | `_site` |
| Workflow | [`.github/workflows/cloudflare-pages.yml`](https://github.com/nirholas/UCAI/blob/main/.github/workflows/cloudflare-pages.yml) |

## DNS

- The domain is registered at Namecheap, with its nameservers set to Cloudflare (`adaline.ns.cloudflare.com`, `greg.ns.cloudflare.com`).
- The Cloudflare zone `ucai.tech` has proxied `CNAME` records for `ucai.tech` and `www.ucai.tech`, both pointing to `ucai-tech.pages.dev`.
- Both hostnames are attached to the Pages project under **Custom domains**, and Cloudflare issues their TLS certificates.

To add a hostname, add it in **Workers & Pages → ucai-tech → Custom domains**. Cloudflare creates the DNS record for you.

## Automatic deploys

Every push to `main` builds the site and uploads it with `wrangler pages deploy`. You can also start a deploy with **Actions → Deploy to Cloudflare Pages → Run workflow**. The workflow reads two repository secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with the **Account → Cloudflare Pages → Edit** permission |
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID (from the dashboard sidebar) |

To set them without putting the values in shell history:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo nirholas/UCAI   # paste the value when prompted
gh secret set CLOUDFLARE_ACCOUNT_ID --repo nirholas/UCAI
```

## Manual deploy

Run these from the repository root. Export `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` first:

```bash
docker run --rm -u "$(id -u):$(id -g)" \
  -v "$PWD:/github/workspace" \
  -e INPUT_SOURCE=docs -e INPUT_DESTINATION=_site \
  -e INPUT_FUTURE=false -e INPUT_VERBOSE=false -e INPUT_BUILD_REVISION="$(git rev-parse HEAD)" \
  -e INPUT_TOKEN="$(gh auth token)" -e GITHUB_WORKSPACE=/github/workspace \
  -e GITHUB_REPOSITORY=nirholas/UCAI -e PAGES_REPO_NWO=nirholas/UCAI -e JEKYLL_ENV=production \
  ghcr.io/actions/jekyll-build-pages:v1.0.13
npx wrangler pages deploy _site --project-name ucai-tech --branch main
```

`--branch main` publishes to production (the custom domains). Any other branch name creates a preview at `https://<branch>.ucai-tech.pages.dev`.

## Rollback

Open **Workers & Pages → ucai-tech → Deployments**, choose an earlier deployment and select **Rollback to this deployment**.

## Web builder: mcp.ucai.tech

The Next.js web builder in `web-v2/` has server routes (`/api/analyze`, `/api/explorer`), so it runs on Google Cloud Run rather than Pages.

| | |
|---|---|
| Cloud Run service | `ucai-web` (project `aerial-vehicle-466722-p5`, region `us-central1`) |
| Origin URL | https://ucai-web-93741856042.us-central1.run.app |
| Public hostname | https://mcp.ucai.tech |
| Cloudflare Worker | `ucai-web-proxy` (source in [`web-v2/deploy/cloudflare-proxy/`](../web-v2/deploy/cloudflare-proxy/)) |

`ETHERSCAN_API_KEY` comes from the Secret Manager secret `etherscan-api-key`. The browser never sees it: client code calls `/api/explorer`, which adds the key on the server and queries the Etherscan V2 API for every supported chain.

Cloud Run domain mappings only work for domains verified in Google Search Console, so the Worker serves `mcp.ucai.tech` on Cloudflare and forwards each request to the run.app URL. It sets `X-Forwarded-Host`, and rewrites redirects that point at the origin back to `mcp.ucai.tech`.

Redeploy the service from `web-v2/` (Cloud Build builds the image; nothing is built locally):

```bash
cd web-v2
gcloud run deploy ucai-web --source . --region us-central1 --allow-unauthenticated \
  --service-account three-ws@aerial-vehicle-466722-p5.iam.gserviceaccount.com \
  --build-service-account projects/aerial-vehicle-466722-p5/serviceAccounts/three-ws-build@aerial-vehicle-466722-p5.iam.gserviceaccount.com \
  --set-secrets ETHERSCAN_API_KEY=etherscan-api-key:latest --memory 1Gi
```

Redeploy the Worker (only needed if the origin URL or the proxy code changes):

```bash
cd web-v2/deploy/cloudflare-proxy
npx wrangler deploy
```

Run the builder locally with `cd web-v2 && npm install && npm run dev`, and put `ETHERSCAN_API_KEY` in `web-v2/.env.local` (see `web-v2/.env.example`).
