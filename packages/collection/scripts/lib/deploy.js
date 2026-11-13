// Deploy a collection from its config: ChampionJson (or an existing one), ChampionMetadata, ChampionCollection,
// then bind them and write the vocabulary. Used by scripts/deploy.js and by the tests, so both deploy the same way.
//
// It NEVER deploys an ERC6699Registry: the registry is an argument, and it must already have code.

/** @typedef {import('../../src/config.js').CollectionConfig} CollectionConfig */

export const TRAIT_INDEX = { kind: 0, faction: 1, alignment: 2, element: 3, frame: 4, kit: 5 };
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * The constructor arguments of ChampionCollection, from a config.
 * @param {CollectionConfig} cfg
 * @param {{ registry: string, metadata: string, admin: string }} at
 */
export function collectionArgs(cfg, at) {
  return [
    cfg.name, cfg.symbol, cfg.setId, at.registry, at.metadata, cfg.identity ?? ZERO, at.admin, cfg.maxSupply,
    { ...cfg.rules, maxParts: [...cfg.rules.maxParts] }, cfg.bands.min, cfg.bands.max,
  ];
}

/**
 * @param {any} ethers  hre.ethers
 * @param {CollectionConfig} cfg
 * @param {{ registry: string, admin?: string, json?: string | null, minters?: string[], log?: (m: string) => void }} opts
 */
export async function deployCollection(ethers, cfg, opts) {
  const log = opts.log ?? (() => {});
  const [signer] = await ethers.getSigners();
  const admin = opts.admin ?? cfg.admin ?? signer.address;
  if (!opts.registry) throw new Error('no ERC6699Registry address: a collection mirrors into an EXISTING registry and never deploys one');
  if ((await ethers.provider.getCode(opts.registry)) === '0x') throw new Error(`no contract at the registry address ${opts.registry} on this chain`);

  const wait = async (/** @type {Promise<any>} */ txp) => (await txp).wait();
  /** @type {Record<string, { address: string, args: unknown[], tx: string | null }>} */
  const record = {};
  const deploy = async (/** @type {string} */ name, /** @type {unknown[]} */ args) => {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    const address = await c.getAddress();
    record[name] = { address, args, tx: c.deploymentTransaction()?.hash ?? null };
    log(`${name}: ${address}`);
    return c;
  };

  const jsonAddr = opts.json ?? cfg.json;
  let json;
  if (jsonAddr) {
    if ((await ethers.provider.getCode(jsonAddr)) === '0x') throw new Error(`no ChampionJson at ${jsonAddr}`);
    json = await ethers.getContractAt('ChampionJson', jsonAddr);
    record.ChampionJson = { address: jsonAddr, args: [], tx: null };
  } else {
    json = await deploy('ChampionJson', []);
  }
  // the deployer administers the metadata while it writes the vocabulary, then hands it to the admin
  const metadata = await deploy('ChampionMetadata', [signer.address, record.ChampionJson.address, cfg.images.base, cfg.images.ext]);
  const collection = await deploy('ChampionCollection', collectionArgs(cfg, { registry: opts.registry, metadata: record.ChampionMetadata.address, admin }));

  await wait(metadata.bindCollection(record.ChampionCollection.address));
  for (const [name, i] of Object.entries(TRAIT_INDEX)) {
    const t = cfg.vocab.traits[/** @type {keyof typeof TRAIT_INDEX} */ (name)];
    if (t.label || t.values.length) await wait(metadata.setTrait(i, t.label, t.values));
  }
  await wait(metadata.setLabels(cfg.vocab.tagline, cfg.vocab.sealedLabel, cfg.vocab.parts));
  await wait(metadata.setLists(cfg.vocab.avatarRequires, cfg.vocab.equipmentSlots));
  const info = cfg.info;
  if (info.description || info.image || info.externalLink) await wait(metadata.setCollectionInfo(info.description, info.image, info.externalLink));
  if (admin.toLowerCase() !== signer.address.toLowerCase()) await wait(metadata.transferAdmin(admin));
  log('metadata bound and vocabulary written');
  // MINTER roles ("deployer" = this signer); only the collection admin can grant them
  const minters = (opts.minters ?? cfg.minters).map((m) => (m === 'deployer' ? signer.address : m));
  if (admin.toLowerCase() === signer.address.toLowerCase()) {
    for (const m of minters) await wait(collection.setMinter(m, true));
    if (minters.length) log(`minters: ${minters.join(', ')}`);
  } else if (minters.length) {
    log(`the admin ${admin} grants minters with collection.setMinter(<address>, true): ${minters.join(', ')}`);
  }
  return { json, metadata, collection, record, admin };
}

/**
 * Whether the registry admin has approved the collection, and what to tell the builder.
 * @param {any} ethers
 * @param {string} registry
 * @param {string} collection
 */
export async function registryStatus(ethers, registry, collection) {
  const r = await ethers.getContractAt('contracts/interfaces/IERC6699Registry.sol:IERC6699Registry', registry);
  const [approved, admin] = await Promise.all([r.minters(collection), r.admin()]);
  return { approved: /** @type {boolean} */ (approved), admin: /** @type {string} */ (admin) };
}
