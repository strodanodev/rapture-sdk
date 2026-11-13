#!/usr/bin/env node
// rapture-collection: the metadata pipeline from the command line.
//
//   rapture-collection check <collection.json>                       validate the config and every token
//   rapture-collection build <collection.json> [--out out] [--image-base ipfs://<CID>/]
//                            [--chain-id 4441 --collection 0x...]   write out/ (see src/build.js)
//   rapture-collection pin <out/upload> [--provider pinata|kubo]    pin the folder; prints the image base
//
// Deploying, minting and verifying are Hardhat scripts: see the README.
import { loadConfig } from './config.js';
import { buildCollection, buildTokens } from './build.js';
import { pinDirectory } from './pin.js';

const [cmd, target, ...rest] = process.argv.slice(2);
/** @param {string} name */
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const usage = 'usage: rapture-collection <check|build|pin> <collection.json | folder> [options] (see README)';

async function main() {
  if (!cmd || !target) throw new Error(usage);
  if (cmd === 'check') {
    const cfg = loadConfig(target);
    const tokens = buildTokens(cfg);
    console.log(`${cfg.name}: ${tokens.length} tokens ok (set ${cfg.setId}, ${cfg.rules.kinds} Kinds)`);
  } else if (cmd === 'build') {
    const cfg = loadConfig(target);
    const chainId = flag('chain-id');
    const { manifest, out } = buildCollection(cfg, flag('out') ?? 'out', {
      imageBase: flag('image-base'),
      chainId: chainId ? Number(chainId) : undefined,
      collection: flag('collection'),
    });
    console.log(`${manifest.tokens.length} tokens, ${manifest.upload.length} files to publish -> ${out}`);
    if (!manifest.imageBase) console.log('no image base yet: pin out/upload, then rebuild with --image-base ipfs://<CID>/');
  } else if (cmd === 'pin') {
    const provider = flag('provider');
    const r = await pinDirectory(target, { provider: provider === 'pinata' || provider === 'kubo' ? provider : undefined });
    console.log(`pinned ${r.files} files with ${r.provider}: ${r.cid}\nimage base: ${r.imageBase}`);
  } else {
    throw new Error(usage);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
