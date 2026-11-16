// The LitNodeWager escrow from the browser (Rapture Chess's src/web3/wager.ts; the contract is
// games/rapture-chess/contracts/LitNodeWager.sol, deployed once per ruleset). zkLTC stakes are bound to a LitNode
// player key and paid out on the host node's signed delta. No signing or resolver here: the client sends through the
// game's wallet, and the proof is LitNode's own (`GET <node>/delta/<matchId>`), re-serialised exactly as the node
// signed it.
//
//   claim(matchId, deltaJson, hostSig)   deltaJson = canonical(delta without hostSig/cosigners/cosigs/disputes)
//                                        hostSig   = the delta's hostSig (64 bytes, ed25519 by the host node)
//   claimWithWinner(..., winnerSig)      a placed match the loser never signed (relay- or host-attested by the title
//                                        publisher's own bonded host), paid on the winner's ledger signature (empty
//                                        for a draw)
//
// The escrow's address is index.html's <meta name="tessaract-wager" content="0x…">: none, and stakes are off.
import { encodeCall, utf8ToHex, words, uintAt, addressAt, boolAt } from "./abi.js";
import { canonical } from "./litnode/mesh/protocol/canonical.js";
import { selector } from "./litnode/mesh/protocol/keccak.js";

// ------------------------------------------------------------------ ids
const HEX64 = /^[0-9a-f]{64}$/;
/** A LitNode id (player key, node key, match id): 64 lowercase hex characters, no 0x. */
export const isLitId = (s) => typeof s === "string" && HEX64.test(s);
/** A LitNode id as the uint256 word the contract takes for a bytes32 (the ABI helper has no bytes32 type). */
const b32 = (id) => {
  const s = String(id).replace(/^0x/, "").toLowerCase();
  if (!HEX64.test(s)) throw new TypeError("expected a 64-hex LitNode id");
  return BigInt(`0x${s}`);
};

// ------------------------------------------------------------------ the claim
/** What the escrow verifies: the canonical bytes the host signed, and its signature. */
export function deltaClaimBytes(delta) {
  const { hostSig, cosigners: _c, cosigs: _s, disputes: _d, verification: _v, official: _o, ...body } = delta;
  if (!/^[0-9a-f]{128}$/.test(hostSig ?? "")) throw new Error("the delta carries no host signature");
  return { json: canonical(body), hostSig: `0x${hostSig}` };
}

/** 0 the first participant won, 1 the second, 2 a draw. */
export function deltaWinner(delta) {
  const [a, b] = delta.participants;
  const sa = delta.scores[a] ?? 0, sb = delta.scores[b] ?? 0;
  return sa === sb ? 2 : sa > sb ? 0 : 1;
}

/** The winner's ledger signature (hex, 64 bytes) among `signatures`, or null (also for a draw). */
export function winnerSignature(delta, signatures) {
  const who = deltaWinner(delta);
  if (who === 2) return null;
  const sig = signatures[delta.participants[who]];
  return sig && /^[0-9a-f]{128}$/.test(sig) ? sig : null;
}

/**
 * Why a delta could not pay out, before spending gas; null when it looks claimable. `signatures` are ledger
 * signatures this device holds (its own): the escrow pays an unsigned-by-the-loser match on the winner's.
 */
export function claimProblem(delta, matchId, rulesetId, signatures = {}) {
  if (delta.matchId !== matchId) return "the delta is for another match";
  if (delta.rulesetId !== rulesetId) return `the delta is for ${delta.rulesetId}, not ${rulesetId}`;
  if (delta.complete === false) return "the match did not finish";
  if (!Array.isArray(delta.participants) || delta.participants.length !== 2 || !delta.participants.every(isLitId)) return "the delta names no two player keys";
  if (!delta.scores || delta.participants.some((p) => typeof delta.scores[p] !== "number")) return "the delta carries no scores";
  if (delta.attestation === "players") return null;
  if (delta.attestation !== "relay" && delta.attestation !== "host") return `the result is ${delta.attestation}-attested: both players must have signed the ledger`;
  if (delta.placed !== true) return "only a match the mesh placed pays out without both signatures";
  if (deltaWinner(delta) !== 2 && !winnerSignature(delta, signatures)) return "the loser did not sign, and the winner's ledger signature is not on this device";
  return null;
}

// ------------------------------------------------------------------ calldata
export const SELECTORS = Object.freeze({
  stake: selector("stake(bytes32)"),
  requestUnstake: selector("requestUnstake()"),
  unstake: selector("unstake()"),
  claim: selector("claim(bytes32,bytes,bytes)"),
  claimWithWinner: selector("claimWithWinner(bytes32,bytes,bytes,bytes)"),
  withdraw: selector("withdraw()"),
  stakeOf: selector("stakeOf(address)"),
  keyOf: selector("keyOf(address)"),
  walletOf: selector("walletOf(bytes32)"),
  claimed: selector("claimed(bytes32)"),
  pending: selector("pending(address)"),
  unstakeDelay: selector("unstakeDelay()"),
  rulesetId: selector("rulesetId()"),
});

export const encodeStake = (playerKey) => encodeCall(SELECTORS.stake, ["uint256"], [b32(playerKey)]);
export const encodeRequestUnstake = () => SELECTORS.requestUnstake;
export const encodeUnstake = () => SELECTORS.unstake;
export const encodeWithdraw = () => SELECTORS.withdraw;
export const encodeClaim = (matchId, json, hostSig) =>
  encodeCall(SELECTORS.claim, ["uint256", "bytes", "bytes"], [b32(matchId), utf8ToHex(json), hostSig]);
/** `winnerSig` is the winner's 64-byte ledger signature as hex (no 0x), or null for a draw. */
export const encodeClaimWithWinner = (matchId, json, hostSig, winnerSig) =>
  encodeCall(SELECTORS.claimWithWinner, ["uint256", "bytes", "bytes", "bytes"], [b32(matchId), utf8ToHex(json), hostSig, winnerSig ? `0x${winnerSig}` : "0x"]);

// ------------------------------------------------------------------ reads
/** { amount, unstakeAt, key }: the wallet's stake, when it may leave, and the player key it is bound to (or null). */
export async function readStake(chain, contract, wallet) {
  const [s, k] = await Promise.all([
    chain.call({ to: contract, data: encodeCall(SELECTORS.stakeOf, ["address"], [wallet]) }),
    chain.call({ to: contract, data: encodeCall(SELECTORS.keyOf, ["address"], [wallet]) }),
  ]);
  const ws = words(s);
  const key = words(k)[0] ?? "";
  return { amount: uintAt(ws, 0), unstakeAt: Number(uintAt(ws, 1)), key: /^0+$/.test(key) ? null : key };
}
export const readWalletOf = async (chain, contract, playerKey) =>
  addressAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.walletOf, ["uint256"], [b32(playerKey)]) })), 0);
export const readClaimed = async (chain, contract, matchId) =>
  boolAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.claimed, ["uint256"], [b32(matchId)]) })), 0);
export const readPending = async (chain, contract, wallet) =>
  uintAt(words(await chain.call({ to: contract, data: encodeCall(SELECTORS.pending, ["address"], [wallet]) })), 0);
export const readUnstakeDelay = async (chain, contract) =>
  Number(uintAt(words(await chain.call({ to: contract, data: SELECTORS.unstakeDelay })), 0));
/** The ruleset the escrow pays on (a string return): a page must not offer stakes on another game's escrow. */
export async function readRulesetId(chain, contract) {
  const hex = await chain.call({ to: contract, data: SELECTORS.rulesetId });
  const w = words(hex);
  const off = Number(uintAt(w, 0)) / 32, len = Number(uintAt(w, off));
  const start = 2 + (off + 1) * 64;
  const bytes = hex.slice(start, start + len * 2).match(/../g) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}

// ------------------------------------------------------------------ amounts
const WEI = 10n ** 18n;
/** "0.25" zkLTC -> wei (up to 18 decimals). */
export function parseZkLtc(text) {
  const m = /^\s*(\d+)(?:\.(\d{1,18}))?\s*$/.exec(String(text));
  if (!m) throw new Error("Enter an amount like 0.05");
  return BigInt(m[1]) * WEI + BigInt((m[2] ?? "").padEnd(18, "0"));
}
export function formatZkLtc(wei, decimals = 4) {
  const whole = wei / WEI, frac = (wei % WEI).toString().padStart(18, "0").slice(0, decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
