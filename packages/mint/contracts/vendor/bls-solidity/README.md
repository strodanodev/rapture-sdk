# bls-solidity (vendored, unmodified)

drand evmnet BLS verification on BN254, used by PackShopV2 as its randomness beacon.

- Source: https://github.com/randa-mu/bls-solidity at commit `11af179a8287d978659aae07adb66aa60f64b8a6` (MIT, see `LICENSE`).
  The repository was archived in December 2025. Its README says "Experimental, unaudited cryptographic code". zkSecurity
  reviewed the library in September 2025 as part of the onlyswaps/dcipher audit.
- Files copied byte for byte: `src/libraries/BLS.sol`, `src/libraries/ModExp.sol`, `src/libraries/Precompiles.sol`,
  `src/demos/EvmnetRegistry.sol`. The other files (BLS12-381, upgradeable helpers) are not needed and were not copied.
- `EvmnetRegistry` is permissionless. Anyone submits a drand evmnet signature for a round. It is verified against the
  League of Entropy evmnet public key (hard-coded) with the BN254 precompiles 0x06–0x08 and the modexp precompile 0x05,
  and then `sha256(signature)` is stored as that round's randomness. That is drand's own randomness definition.
- Tests run it against real evmnet signatures (`test/fixtures/evmnet-rounds.json`, fetched from api.drand.sh).

sha256 of the copied files:

```
648f351a44699f5e23ba035d388617891a820ddb84f423af7875ed9d1ac30fa8  src/libraries/BLS.sol
47d46311eb25d86de97b335f9c58f936164a1311e54f2519b33225084662498a  src/libraries/ModExp.sol
ca7ca28f0811a20e0b67d0c7efccea0a185e05ec749ec72060ffd26769183c4f  src/libraries/Precompiles.sol
34e726dbcf112a677d37d17d04ebfbcaf26af69356271c277ccd449a3497213d  src/demos/EvmnetRegistry.sol
```
