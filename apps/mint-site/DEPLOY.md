# Deploy the mint site on Vercel

The site is static: Vercel serves the `web/` folder with the headers in `vercel.json`. There is nothing to build, no
server code and no environment variable, and nothing secret is in the site: every value in `site.config.json` is
public on chain anyway.

## Before you deploy

1. The minter is deployed and stocked, and it holds the MINTER role on the collection. See the mint package's README.
2. `web/site.config.json` points at it (`node scripts/site-config.mjs` in the mint package writes `chain`, `mint` and
   `cards`), and the words, colours, logo and art are yours.
3. From this folder:

   ```bash
   pnpm csp            # vercel.json's Content-Security-Policy for this config
   pnpm run check      # config, art paths, CSP, the pages, the tests
   pnpm dev            # look at it on http://localhost:5180 against the real chain, then connect a wallet
   ```

## Deploy with the Vercel CLI

```bash
npm i -g vercel
vercel login
vercel link          # in this folder (apps/mint-site): create or pick a project
vercel deploy        # a preview URL: open it, connect a wallet, check every page
vercel deploy --prod # your production URL
```

`vercel.json` sets everything the project needs: no framework, no install (an empty `installCommand`: the only
dependency is the one the tests use) and output directory `web`. There is no build script, so Vercel serves `web/` as it is.
If you copy the template into its own repository, deploy from that repository's root instead.

## Deploy from Git

1. Push your copy of the template to GitHub (its own repository, or this folder of a larger one).
2. In Vercel: **Add New… → Project**, import the repository.
3. **Root Directory**: the folder that holds `vercel.json` (for example `apps/mint-site`). Leave Framework Preset as
   "Other" and the build settings at their defaults (vercel.json sets the output directory).
4. Deploy. Every push to the production branch redeploys; other branches get preview URLs.

## Your domain

In the project: **Settings → Domains → Add**, then follow Vercel's DNS instructions (an `A`/`CNAME` record at your DNS
host, or nothing at all if the domain is already on Vercel DNS). HTTPS is automatic.

## After deploying

- Open the site in a browser with the developer console open: there must be no Content-Security-Policy errors. A
  blocked request means the config names a host the CSP does not allow: run `pnpm csp` and redeploy.
- Check the response headers once: `curl -sI https://<your-site>/ | grep -i content-security-policy`.
- Connect a wallet, mint one card, and find it under "My cards".
- `site.config.json` is served with `Cache-Control: no-cache`, so a changed price or address shows on the next load.

## When something changes

| Change | Do |
|---|---|
| a new minter address, chain or RPC | `node scripts/site-config.mjs …` in the mint package, `pnpm csp`, redeploy |
| words, colours, logo, art | edit the config or the files, `pnpm run check`, redeploy |
| an IPFS gateway for token metadata | set `ipfsGateway`, `pnpm csp`, redeploy |
| the shop is paused or sold out | nothing: the pages read it from the chain |
