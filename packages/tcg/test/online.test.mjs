// Ranked play from the site (web/lib/litnode, web/lib/wager.js): the escrow's calldata, the claim bytes a LitNode host
// signed, the PlayerProfile binding, the ladder's sanitising, and the CabinetShell the page signs seats and ledgers with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SELECTORS, claimProblem, deltaClaimBytes, deltaWinner, encodeClaim, encodeClaimWithWinner, encodeStake, formatZkLtc, isLitId, parseZkLtc, winnerSignature,
} from "../web/lib/wager.js";
import { NAME_RE, encodeBindKey, encodeRegister } from "../web/lib/litnode/profile.js";
import { lineOf } from "../web/lib/litnode/ladder.js";
import { localShell } from "../web/lib/litnode/ranked.js";
import { generateKeypair, signingBytes, verify, verifyRaw } from "../web/lib/litnode/mesh/protocol/keys.js";
import { roomCodeFor } from "../web/lib/litnode/mesh/protocol/pairing.js";

const DELTA = JSON.parse(readFileSync(new URL("./fixtures/litnode-delta-host.json", import.meta.url), "utf8"));
const A = "a".repeat(64), B = "b".repeat(64), M = "c".repeat(64);

test("escrow selectors are the Solidity ones (keccak256 of the signature)", () => {
  // the same values ethers / @noble/hashes give (checked against games/rapture-chess/src/web3/wager.ts)
  assert.equal(SELECTORS.stake, "0xc0d64a87");
  assert.equal(SELECTORS.claim, "0xf7349b91");
  assert.equal(SELECTORS.claimWithWinner, "0x13528d5d");
  assert.equal(SELECTORS.rulesetId, "0x964d3f12");
  assert.equal(SELECTORS.keyOf, "0xfa073d76");
});

test("stake and claim calldata", () => {
  assert.equal(encodeStake(A), `0xc0d64a87${A}`);
  assert.throws(() => encodeStake("0x12"), /64-hex/);
  const json = '{"a":1}', sig = `0x${"cd".repeat(64)}`;
  const claim = encodeClaim(M, json, sig);
  assert.ok(claim.startsWith(`0xf7349b91${M}`));
  // head: matchId, offset of json (0x60), offset of sig; json is 7 bytes in one padded word
  assert.equal(claim.slice(74, 138), (0x60).toString(16).padStart(64, "0"));
  assert.ok(claim.includes(Buffer.from(json).toString("hex")));
  // a draw carries an empty winner signature: four head words, then each dynamic tail
  const draw = encodeClaimWithWinner(M, json, sig, null);
  assert.equal((draw.length - 10) / 64, 4 + 2 + 3 + 1);
});

test("the claim bytes are exactly what the host node signed", async () => {
  const { json, hostSig } = deltaClaimBytes(DELTA);
  assert.ok(!json.includes('"hostSig"') && !json.includes('"cosigs"') && !json.includes('"verification"'));
  const msg = new Uint8Array([...Buffer.from("delta"), 0, ...Buffer.from(json)]);
  assert.equal(await verifyRaw(msg, hostSig.slice(2), DELTA.hostId), true);
  // one changed score and the signature no longer holds
  const tampered = deltaClaimBytes({ ...DELTA, scores: Object.fromEntries(Object.keys(DELTA.scores).map((k) => [k, 0])) });
  assert.equal(await verifyRaw(new Uint8Array([...Buffer.from("delta"), 0, ...Buffer.from(tampered.json)]), hostSig.slice(2), DELTA.hostId), false);
  assert.throws(() => deltaClaimBytes({ ...DELTA, hostSig: "" }), /no host signature/);
});

test("claimProblem says why a delta can't pay, before any gas is spent", () => {
  const d = { matchId: M, rulesetId: "duel.v1", participants: [A, B], scores: { [A]: 1, [B]: 0 }, attestation: "players", complete: true, placed: true };
  assert.equal(claimProblem(d, M, "duel.v1"), null);
  assert.match(claimProblem(d, B, "duel.v1"), /another match/);
  assert.match(claimProblem(d, M, "chess.v1"), /not chess\.v1/);
  assert.match(claimProblem({ ...d, complete: false }, M, "duel.v1"), /did not finish/);
  const relay = { ...d, attestation: "relay" };
  assert.match(claimProblem(relay, M, "duel.v1"), /winner's ledger signature/);
  assert.equal(claimProblem(relay, M, "duel.v1", { [A]: "ef".repeat(64) }), null);
  assert.match(claimProblem({ ...relay, placed: false }, M, "duel.v1"), /placed/);
  assert.equal(deltaWinner(d), 0);
  assert.equal(deltaWinner({ ...d, scores: { [A]: 1, [B]: 1 } }), 2);
  assert.equal(winnerSignature({ ...d, scores: { [A]: 0, [B]: 1 } }, { [B]: "01".repeat(64) }), "01".repeat(64));
});

test("zkLTC amounts round-trip; ids are 64 lowercase hex", () => {
  assert.equal(parseZkLtc("0.05"), 5n * 10n ** 16n);
  assert.equal(formatZkLtc(parseZkLtc("1.2500")), "1.25");
  assert.throws(() => parseZkLtc("1e3"), /amount/);
  assert.ok(isLitId(A) && !isLitId(A.toUpperCase()) && !isLitId(`0x${A}`));
});

test("PlayerProfile: register(bytes32,string) and bindKey(bytes32)", () => {
  const reg = encodeRegister(A, "Odin");
  // selector, key, offset 0x40, length 4, "Odin" right-padded
  assert.equal(reg.slice(10, 74), A);
  assert.equal(BigInt(`0x${reg.slice(74, 138)}`), 64n);
  assert.equal(BigInt(`0x${reg.slice(138, 202)}`), 4n);
  assert.ok(reg.slice(202).startsWith(Buffer.from("Odin").toString("hex")));
  assert.equal(encodeBindKey(A).slice(10), A);
  assert.ok(NAME_RE.test("Thor_of-Asgard 2.0") && !NAME_RE.test("<b>") && !NAME_RE.test("x".repeat(33)));
  assert.throws(() => encodeRegister(A, "bad<name>"), /letters/);
});

test("ladder lines are numbers and strings whatever the node sends", () => {
  const l = lineOf({ player: A, rating: "1512.6", wins: 3, losses: null, streak: "x" }, 4);
  assert.deepEqual([l.rank, l.player, l.rating, l.wins, l.losses, l.streak], [5, A, 1513, 3, 0, 0]);
});

test("the page's own shell signs only the match it queued for", async () => {
  const kp = await generateKeypair();
  let seen = null;
  const shell = localShell(kp, "https://node.example", { matchId: M, buildHash: "f".repeat(64), wsAddr: "wss://node.example", participants: [kp.publicKey, B], rulesetId: "duel.v1" }, (sig) => { seen = sig; });
  const challenge = { matchId: M, room: roomCodeFor(M), player: kp.publicKey, nonce: "0123456789abcdef" };
  const seatSig = await shell.signSeat(challenge);
  assert.equal(await verify("seat", challenge, seatSig, kp.publicKey), true);
  await assert.rejects(shell.signSeat({ ...challenge, matchId: B }), /not a seat/);
  await assert.rejects(shell.signSeat({ ...challenge, player: B }), /not a seat/);
  const entries = [{ k: 0, inputs: [1] }, { k: 1, inputs: [2] }];
  const sig = await shell.signLedger(M, "f".repeat(64), entries);
  assert.equal(seen, sig);
  await assert.rejects(shell.signLedger(B, null, entries), /not the match/);
  await assert.rejects(shell.signLedger(M, "e".repeat(64), entries), /another build/);
  assert.ok(signingBytes("ledger", { matchId: M }).length > 0);
});
