// LitNode's PlayerProfile (contracts/PlayerProfile.sol): one soulbound profile per wallet, any number of player keys
// bound to it. A ranked match's relay reads it to learn which wallet a player key plays for, so the champion and the
// owned-only deck are checked against that wallet's NFTs; an unbound key plays with the base champion and support
// cards only. The profile's name is what the leaderboard shows beside a key.
import { encodeCall, utf8ToHex, words, uintAt, addressAt, boolAt } from "../abi.js";
import { selector } from "./mesh/protocol/keccak.js";

/** LitNode generation 3 (arcade.litvm.games/contracts.json), the address the relay's chain preset reads too. */
export const PLAYER_PROFILE = "0xe2cf46ab11eAfB18c1933409E35ae68CEce88882";
const SEL = {
  ownerOfKey: selector("ownerOfKey(bytes32)"),
  profileOf: selector("profileOf(address)"),
  nameOf: selector("nameOf(uint256)"),
  register: selector("register(bytes32,string)"),
  bindKey: selector("bindKey(bytes32)"),
};
const ZERO = "0x0000000000000000000000000000000000000000";
const b32 = (id) => BigInt(`0x${String(id).replace(/^0x/, "")}`);

/** A profile name the contract accepts: 1 to 32 of letters, digits, space, _ . - */
export const NAME_RE = /^[A-Za-z0-9 _.-]{1,32}$/;

function decodeString(hex) {
  const w = words(hex);
  if (!w.length) return "";
  const off = Number(uintAt(w, 0)) / 32, len = Number(uintAt(w, off));
  const start = 2 + (off + 1) * 64;
  const bytes = hex.slice(start, start + len * 2).match(/../g) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}

/** { owner, tokenId, active } for a player key; owner is null when the key was never bound. */
export async function ownerOfKey(chain, key) {
  const w = words(await chain.call({ to: PLAYER_PROFILE, data: encodeCall(SEL.ownerOfKey, ["uint256"], [b32(key)]) }));
  const owner = addressAt(w, 0);
  return { owner: owner === ZERO ? null : owner, tokenId: Number(uintAt(w, 1)), active: boolAt(w, 2) };
}
export const profileOf = async (chain, wallet) =>
  Number(uintAt(words(await chain.call({ to: PLAYER_PROFILE, data: encodeCall(SEL.profileOf, ["address"], [wallet]) })), 0));
export const nameOf = async (chain, tokenId) =>
  decodeString(await chain.call({ to: PLAYER_PROFILE, data: encodeCall(SEL.nameOf, ["uint256"], [BigInt(tokenId)]) }));

/** register(key, name): mint the wallet's profile and bind its first key, in one transaction. */
export const encodeRegister = (key, name) => {
  if (!NAME_RE.test(name)) throw new Error("A name is 1 to 32 letters, digits, spaces, dots, dashes or underscores");
  // a string is ABI-encoded exactly as bytes (length word, then the UTF-8 right-padded): the encoder's "bytes" does it
  return encodeCall(SEL.register, ["uint256", "bytes"], [b32(key), utf8ToHex(name)]);
};
/** bindKey(key): add this browser's key to the wallet's existing profile. */
export const encodeBindKey = (key) => encodeCall(SEL.bindKey, ["uint256"], [b32(key)]);

const names = new Map();
/** The profile name a player key plays under ("" when unbound or unreadable), cached for the page's life. */
export function keyName(chain, key) {
  if (!names.has(key)) {
    names.set(key, ownerOfKey(chain, key)
      .then((o) => (o.owner && o.active && o.tokenId ? nameOf(chain, o.tokenId) : ""))
      .catch(() => { names.delete(key); return ""; }));
  }
  return names.get(key);
}
