// Optional IPFS pinning of out/upload as ONE directory: its CID becomes the image base (ipfs://<CID>/).
//
//   pinata  PINATA_JWT                         https://api.pinata.cloud/pinning/pinFileToIPFS
//   kubo    IPFS_API_URL (http://127.0.0.1:5001) a local or remote Kubo node's /api/v0/add
//
// Keys come from the environment only. The tests pass a mock fetch; nothing here runs in `pnpm check` against a
// network.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** @typedef {(input: string, init?: RequestInit) => Promise<Response>} Fetch */

/**
 * @param {string} dir
 * @returns {{ name: string, path: string }[]}
 */
function filesOf(dir) {
  return readdirSync(dir)
    .filter((n) => statSync(join(dir, n)).isFile())
    .sort()
    .map((n) => ({ name: n, path: join(dir, n) }));
}

/**
 * Pin a directory. Returns its root CID and the image base to set on chain.
 * @param {string} dir
 * @param {{ provider?: 'pinata' | 'kubo', env?: Record<string, string | undefined>, fetch?: Fetch, name?: string }} [opts]
 * @returns {Promise<{ cid: string, imageBase: string, provider: string, files: number }>}
 */
export async function pinDirectory(dir, opts = {}) {
  const env = opts.env ?? process.env;
  const f = opts.fetch ?? /** @type {Fetch} */ (globalThis.fetch);
  const root = resolve(dir);
  const files = filesOf(root);
  if (files.length === 0) throw new Error(`${root}: nothing to pin`);
  const folder = opts.name ?? basename(root);
  const provider = opts.provider ?? (env.PINATA_JWT ? 'pinata' : env.IPFS_API_URL ? 'kubo' : null);
  if (!provider) throw new Error('no pinning provider: set PINATA_JWT (Pinata) or IPFS_API_URL (a Kubo node), or pass --provider');

  const form = new FormData();
  for (const file of files) {
    const blob = new Blob([readFileSync(file.path)]);
    // both APIs take a directory as files whose names carry the folder: <folder>/<file>
    form.append('file', blob, `${folder}/${file.name}`);
  }

  let cid;
  if (provider === 'pinata') {
    const jwt = env.PINATA_JWT;
    if (!jwt) throw new Error('PINATA_JWT is not set');
    form.append('pinataMetadata', JSON.stringify({ name: folder }));
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1, wrapWithDirectory: false }));
    const r = await f('https://api.pinata.cloud/pinning/pinFileToIPFS', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
    if (!r.ok) throw new Error(`Pinata answered ${r.status}: ${await r.text()}`);
    cid = /** @type {{ IpfsHash?: string }} */ (await r.json()).IpfsHash;
  } else if (provider === 'kubo') {
    const api = (env.IPFS_API_URL ?? '').replace(/\/+$/, '');
    if (!api) throw new Error('IPFS_API_URL is not set');
    const r = await f(`${api}/api/v0/add?cid-version=1&pin=true&wrap-with-directory=false&quieter=false`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`Kubo answered ${r.status}: ${await r.text()}`);
    // newline-delimited JSON, one line per file and one for the folder itself
    const lines = (await r.text()).trim().split('\n').map((l) => /** @type {{ Name: string, Hash: string }} */ (JSON.parse(l)));
    cid = lines.find((l) => l.Name === folder)?.Hash;
  } else {
    throw new Error(`unknown provider: ${provider}`);
  }
  if (!cid) throw new Error(`${provider} returned no CID`);
  return { cid, imageBase: `ipfs://${cid}/`, provider, files: files.length };
}
