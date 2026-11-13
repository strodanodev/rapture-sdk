// abi.js against ethers: every hard-coded selector/topic, every encoder byte for byte, every decoder on ethers-made data.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AbiError, SELECTORS, MINTER_SELECTORS, TOPICS, ERROR_SELECTORS, ERROR_STRING, PANIC, isHex, isAddress, hexToBytes, bytesToHex, utf8ToHex,
  toBigInt, toQuantity, fromQuantity, encodeUint, encodeAddress, encodeBool, encodeBytes, encodeArgs, encodeCall,
  words, uintAt, uintBoundAt, addressAt, boolAt, uintArrayAt, decodePackBought, decodePackDealt, decodePackOpened,
  decodePackRefunded, decodeRecentPacks, decodePackOf, decodeUintArray, decodeDeck, decodeRevert, extractRevertData,
} from "../web/lib/abi.js";
import { ethers, shopIface, fixedIface, otherIfaces, ALICE, BOB, SHOP, revertData } from "./helpers.mjs";

const coder = ethers.AbiCoder.defaultAbiCoder();
// small deterministic PRNG so the "random" cases are the same on every run
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const randBig = (r, bits) => { let v = 0n; for (let i = 0; i < Math.ceil(bits / 32); i++) v = (v << 32n) | BigInt(Math.floor(r() * 2 ** 32)); return v & ((1n << BigInt(bits)) - 1n); };
const randBytes = (r, n) => bytesToHex(Uint8Array.from({ length: n }, () => Math.floor(r() * 256)));
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const hex = (...ns) => "0x" + ns.map(w).join("");

test("function selectors equal ethers' for the compiled PackShopV2 ABI", () => {
  for (const [name, selector] of Object.entries(SELECTORS)) {
    assert.equal(selector, shopIface.getFunction(name).selector, name);
  }
  assert.deepEqual(Object.keys(SELECTORS).sort(), [
    "buyPack", "config", "deal", "deckInitial", "deckRemaining", "finishesOf", "minter", "openPack", "packOf", "packsLeftToday",
    "pendingRounds", "phaseOf", "recentPacks", "refund", "shutdownAt", "tokensOf",
  ]);
  const studioMinter = otherIfaces[0];
  for (const [name, selector] of Object.entries(MINTER_SELECTORS)) assert.equal(selector, studioMinter.getFunction(name).selector, name);
  assert.deepEqual(studioMinter.getFunction("minters").outputs.map((o) => o.type), ["bool"]);
  // the calls and views the client leans on, with the argument and result shapes it encodes and decodes
  const shape = (name) => {
    const f = shopIface.getFunction(name);
    return [f.format("sighash"), f.outputs.map((o) => o.type), f.stateMutability];
  };
  assert.deepEqual(shape("openPack"), ["openPack(uint256,uint64[],bytes[])", ["uint256[]"], "nonpayable"]);
  assert.deepEqual(shape("deal"), ["deal(uint256,uint64[],bytes[])", ["uint256"], "nonpayable"]);
  assert.deepEqual(shape("recentPacks"), ["recentPacks(address,uint256)", ["uint256[]", "uint8[]", "uint64[]"], "view"]);
  assert.deepEqual(shape("packOf"), ["packOf(uint256)", ["address", "uint64", "uint8", "uint256", "uint16[]", "uint8[]"], "view"]);
  assert.deepEqual(shape("pendingRounds"), ["pendingRounds(uint256,uint256)", ["uint64[]"], "view"]);
  assert.deepEqual(shape("finishesOf"), ["finishesOf(uint256[])", ["uint8[]"], "view"]);
  assert.deepEqual(shape("deckRemaining"), ["deckRemaining()", ["uint16[3][5]"], "view"]);
  assert.deepEqual(shape("shutdownAt"), ["shutdownAt()", ["uint64"], "view"]);
  assert.deepEqual(shape("tokensOf"), ["tokensOf(uint256)", ["uint256[]"], "view"]);
  assert.deepEqual(shape("minter"), ["minter()", ["address"], "view"]);
  assert.deepEqual(shopIface.getFunction("config").outputs.map((o) => o.type),
    ["uint256", "uint8", "uint16", "bool", "bool", "uint32", "uint32", "uint32", "uint256", "uint256"]);
  assert.deepEqual(shopIface.getFunction("config").outputs.map((o) => o.name),
    ["price_", "packSize_", "dailyLimit_", "paused_", "ready_", "maxSupply_", "packsTotal_", "packsSold_", "cardsLeft_", "templateCount_"]);
});

test("event topic0 values equal ethers' for the compiled PackShopV2 ABI", () => {
  for (const [name, topic] of Object.entries(TOPICS)) {
    assert.equal(topic, shopIface.getEvent(name).topicHash, name);
  }
  assert.deepEqual(Object.keys(TOPICS).sort(), ["PackBought", "PackDealt", "PackOpened", "PackRefunded"]);
});

test("error selectors equal ethers' (both minters, OpenZeppelin, and the card contracts they mint through)", () => {
  const all = [shopIface, fixedIface, ...otherIfaces];
  for (const [name, selector] of Object.entries(ERROR_SELECTORS)) {
    const frag = all.map((i) => i.getError(name)).find(Boolean);
    assert.ok(frag, `${name} is not in any compiled ABI`);
    assert.equal(selector, frag.selector, name);
  }
  // every PackShopV2 custom error a player (or this client) can trigger is covered
  for (const name of ["NotLocked", "IsShutdown", "SoldOut", "WrongPayment", "DailyLimitReached", "NotMinter", "BadPack", "NotDealt",
    "BeaconMissing", "BadProof", "NotRefundable", "TransferFailed", "EnforcedPause", "ReentrancyGuardReentrantCall"]) {
    assert.ok(ERROR_SELECTORS[name], `${name} missing from ERROR_SELECTORS`);
  }
  assert.equal(ERROR_SELECTORS.BeaconMissing, shopIface.getError("BeaconMissing(uint64)").selector);
  assert.equal(ERROR_STRING, ethers.id("Error(string)").slice(0, 10));
  assert.equal(PANIC, ethers.id("Panic(uint256)").slice(0, 10));
});

test("hex helpers round-trip and reject garbage", () => {
  const r = rng(1);
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
    const h = bytesToHex(bytes);
    assert.equal(h, ethers.hexlify(bytes));
    assert.deepEqual(hexToBytes(h), bytes);
  }
  assert.equal(bytesToHex(new Uint8Array()), "0x");
  for (const bad of ["", "0x1", "0xzz", "12", 12, null, undefined, "0x 12"]) {
    assert.equal(isHex(bad), false, String(bad));
    assert.throws(() => hexToBytes(bad), AbiError);
  }
  assert.equal(isHex("0x"), true);
  assert.equal(isHex("0xAbCd", 2), true);
  assert.equal(isHex("0xabcd", 3), false);
  assert.equal(isAddress(ALICE), true);
  assert.equal(isAddress(ALICE.toLowerCase()), true);
  assert.equal(isAddress(ALICE.slice(0, 40)), false);
  assert.equal(isAddress("0x" + "g".repeat(40)), false);
  assert.equal(utf8ToHex("héllo ✓ 🔥"), ethers.hexlify(ethers.toUtf8Bytes("héllo ✓ 🔥")));
});

test("quantities: minimal hex both ways, bigint-safe", () => {
  const cases = [[0, "0x0"], [1, "0x1"], [255, "0xff"], [256, "0x100"], [4441, "0x1159"], [(1n << 64n) + 5n, "0x10000000000000005"], [(1n << 256n) - 1n, "0x" + "f".repeat(64)]];
  for (const [n, h] of cases) {
    assert.equal(toQuantity(n), h);
    assert.equal(fromQuantity(h), BigInt(n));
    assert.equal(toQuantity(h), h);                  // hex strings pass through
    assert.equal(toQuantity(String(BigInt(n))), h);  // and so do decimal strings
    assert.equal(toQuantity(BigInt(n)), h);
    assert.equal(toQuantity("0x000" + h.slice(2)), h, "leading zeros are trimmed");
  }
  assert.equal(toQuantity(4441), ethers.toQuantity(4441));
  for (const bad of [-1, -1n, 1.5, NaN, Infinity, 2 ** 60, "1.5", "-3", "0x", "abc", null, undefined, {}]) {
    assert.throws(() => toQuantity(bad), AbiError, String(bad));
  }
  for (const bad of ["0x", "1", 1, null, "0xzz"]) assert.throws(() => fromQuantity(bad), AbiError, String(bad));
  assert.equal(toBigInt("0007"), 7n);
});

test("static encoders: calldata is byte-identical to ethers.Interface.encodeFunctionData", () => {
  for (const name of ["buyPack", "config", "deckRemaining", "deckInitial", "shutdownAt"]) {
    assert.equal(encodeCall(SELECTORS[name]), shopIface.encodeFunctionData(name), name);
  }
  const r = rng(7);
  const ids = [0n, 1n, 2n, 255n, 256n, 2n ** 32n, 2n ** 53n, 2n ** 64n - 1n, 2n ** 128n, 2n ** 255n, 2n ** 256n - 1n];
  for (let i = 0; i < 40; i++) ids.push(randBig(r, 256), randBig(r, 64), randBig(r, 20));
  for (const id of ids) {
    for (const name of ["phaseOf", "packOf", "refund"]) {
      assert.equal(encodeCall(SELECTORS[name], ["uint256"], [id]), shopIface.encodeFunctionData(name, [id]), `${name}(${id})`);
    }
    assert.equal(encodeCall(SELECTORS.pendingRounds, ["uint256", "uint256"], [id, 17]), shopIface.encodeFunctionData("pendingRounds", [id, 17]));
  }
  // the same integer as bigint / safe number / decimal string / hex string
  for (const v of ["12345", 12345, 12345n, "0x3039"]) assert.equal(encodeCall(SELECTORS.phaseOf, ["uint256"], [v]), shopIface.encodeFunctionData("phaseOf", [12345n]));
  // addresses: checksummed, lowercase and uppercase all encode to the same word
  for (const a of [ALICE, ALICE.toLowerCase(), "0x" + ALICE.slice(2).toUpperCase(), BOB, SHOP]) {
    const checksummed = ethers.getAddress(a.toLowerCase());
    assert.equal(encodeCall(SELECTORS.packsLeftToday, ["address"], [a]), shopIface.encodeFunctionData("packsLeftToday", [checksummed]));
    for (const n of [0, 1, 16, 17, "16", 16n, 2n ** 256n - 1n]) {
      assert.equal(encodeCall(SELECTORS.recentPacks, ["address", "uint256"], [a, n]), shopIface.encodeFunctionData("recentPacks", [checksummed, n]), `recentPacks(${a}, ${n})`);
    }
  }
  // other static types, against ethers' own coder
  assert.equal(encodeArgs(["uint256", "address", "bool", "uint16", "uint8"], [7n, BOB, true, 65535, 255]),
    coder.encode(["uint256", "address", "bool", "uint16", "uint8"], [7n, BOB, true, 65535, 255]).slice(2));
  assert.equal(encodeBool(false), coder.encode(["bool"], [false]).slice(2));
  assert.equal(encodeUint(0), "0".repeat(64));
});

test("dynamic encoders: openPack / deal with drand proofs and finishesOf match ethers byte for byte", () => {
  const r = rng(9);
  const sig = () => randBytes(r, 64);
  const proofs = [
    [[], []],
    [[21615400n], [sig()]],
    [[1n, 2n, 3n], [sig(), sig(), sig()]],
    [Array.from({ length: 16 }, (_, i) => 21_000_000n + BigInt(i) * 4n), Array.from({ length: 16 }, sig)],
    [[2n ** 64n - 1n, 1n], [sig(), sig()]],
  ];
  for (const [rounds, sigs] of proofs) {
    for (const id of [1n, 177n, 2n ** 200n]) {
      assert.equal(encodeCall(SELECTORS.openPack, ["uint256", "uint64[]", "bytes[]"], [id, rounds, sigs]), shopIface.encodeFunctionData("openPack", [id, rounds, sigs]), `openPack(${id}, ${rounds.length} proofs)`);
      assert.equal(encodeCall(SELECTORS.deal, ["uint256", "uint64[]", "bytes[]"], [0n, rounds, sigs]), shopIface.encodeFunctionData("deal", [0n, rounds, sigs]));
    }
  }
  // rounds as numbers or decimal strings, signatures as hex or bytes: the same calldata
  const s = sig();
  assert.equal(encodeCall(SELECTORS.openPack, ["uint256", "uint64[]", "bytes[]"], ["7", [5, "6"], [s, hexToBytes(s)]]), shopIface.encodeFunctionData("openPack", [7n, [5n, 6n], [s, s]]));
  // bytes of every awkward length (padding to whole words), alone and in arrays, against ethers' coder
  for (const n of [0, 1, 31, 32, 33, 63, 64, 65, 100]) {
    const b = randBytes(r, n);
    assert.equal(encodeBytes(b), coder.encode(["bytes"], [b]).slice(2 + 64), `bytes(${n})`);
    assert.equal(encodeArgs(["bytes"], [b]), coder.encode(["bytes"], [b]).slice(2));
    assert.equal(encodeArgs(["bytes[]", "uint64[]", "bytes"], [[b, "0x", b], [1n, 2n], b]), coder.encode(["bytes[]", "uint64[]", "bytes"], [[b, "0x", b], [1n, 2n], b]).slice(2));
  }
  for (const ids of [[], [1n], Array.from({ length: 200 }, () => randBig(r, 256)), [(7n << 32n) + 1n, 2n ** 256n - 1n]]) {
    assert.equal(encodeCall(SELECTORS.finishesOf, ["uint256[]"], [ids]), shopIface.encodeFunctionData("finishesOf", [ids]));
  }
});

test("encoders refuse what does not fit or is not what it claims", () => {
  assert.throws(() => encodeUint(-1), AbiError);
  assert.throws(() => encodeUint(2n ** 256n), AbiError);
  assert.throws(() => encodeUint(256, 8), AbiError);
  assert.throws(() => encodeUint(65536, 16), AbiError);
  assert.doesNotThrow(() => encodeUint(65535, 16));
  assert.throws(() => encodeUint(1.5), AbiError);
  assert.throws(() => encodeUint(2 ** 53), AbiError, "unsafe integers are refused, not rounded");
  assert.throws(() => encodeUint("banana"), AbiError);
  for (const bad of ["0x1234", ALICE.slice(0, -1), ALICE + "00", "0x" + "z".repeat(40), "", null, 5]) {
    assert.throws(() => encodeAddress(bad), AbiError, String(bad));
  }
  assert.throws(() => encodeBool(1), AbiError);
  assert.throws(() => encodeArgs(["uint256"], []), AbiError);
  assert.throws(() => encodeArgs(["string"], ["x"]), /unsupported type/);
  assert.throws(() => encodeCall("0x1234", [], []), AbiError);
  assert.throws(() => encodeCall("c37b9bcd"), AbiError);
  // the dynamic shapes
  assert.throws(() => encodeArgs(["uint64[]"], [[2n ** 64n]]), /does not fit in uint64/);
  assert.throws(() => encodeArgs(["uint64[]"], ["5"]), /needs an array/);
  assert.throws(() => encodeArgs(["bytes[]"], [["0x123"]]), AbiError, "odd-length hex");
  assert.throws(() => encodeArgs(["bytes[]"], [["nothex"]]), AbiError);
  assert.throws(() => encodeArgs(["bytes"], [5]), AbiError);
  assert.throws(() => encodeArgs(["string[]"], [["x"]]), /unsupported type/);
});

test("word decoders read static values, and bounded ones refuse wider words", () => {
  const data = coder.encode(["uint256", "address", "bool", "bool"], [2n ** 200n + 3n, BOB, true, false]);
  const ws = words(data);
  assert.equal(ws.length, 4);
  assert.equal(uintAt(ws, 0), 2n ** 200n + 3n);
  assert.equal(addressAt(ws, 1), BOB.toLowerCase());
  assert.equal(boolAt(ws, 2), true);
  assert.equal(boolAt(ws, 3), false);
  assert.throws(() => uintAt(ws, 4), AbiError, "past the end");
  assert.throws(() => uintAt(ws, -1), AbiError);
  assert.throws(() => boolAt(words(coder.encode(["uint256"], [2n])), 0), AbiError, "2 is not a bool");
  assert.throws(() => addressAt(words(coder.encode(["uint256"], [2n ** 160n])), 0), AbiError, "dirty upper bits");
  assert.throws(() => words("0x" + "00".repeat(31)), AbiError, "not a whole number of words");
  assert.throws(() => words("nope"), AbiError);
  assert.deepEqual(words("0x"), []);
  const b = words(hex(255, 256, 2n ** 64n - 1n, 2n ** 64n));
  assert.equal(uintBoundAt(b, 0, 8), 255n);
  assert.throws(() => uintBoundAt(b, 1, 8), /does not fit in uint8/);
  assert.equal(uintBoundAt(b, 2, 64), 2n ** 64n - 1n);
  assert.throws(() => uintBoundAt(b, 3, 64), /does not fit in uint64/);
});

test("config() result decodes word by word (ten static words)", () => {
  const price = 123456789012345678901n;
  const raw = shopIface.encodeFunctionResult("config", [price, 5, 3, false, true, 888, 177, 12, 828, 50]);
  const ws = words(raw);
  assert.equal(ws.length, 10);
  assert.equal(uintAt(ws, 0), price);
  assert.deepEqual([1, 2, 5, 6, 7, 8, 9].map((i) => Number(uintAt(ws, i))), [5, 3, 888, 177, 12, 828, 50]);
  assert.equal(boolAt(ws, 3), false);
  assert.equal(boolAt(ws, 4), true);
});

const eventLog = (name, args) => ({ address: SHOP.toLowerCase(), ...shopIface.encodeEventLog(shopIface.getEvent(name), args) });

test("PackBought decodes ethers-encoded logs, round included", () => {
  const r = rng(3);
  const cases = [[1n, BOB, 10n ** 15n, 21_615_404n], [0n, ALICE, 0n, 0n], [2n ** 256n - 1n, ALICE, 2n ** 256n - 1n, 2n ** 64n - 1n]];
  for (let i = 0; i < 20; i++) cases.push([randBig(r, 256), i % 2 ? ALICE : BOB, randBig(r, 128), randBig(r, 40)]);
  for (const [packId, buyer, paid, round] of cases) {
    assert.deepEqual(decodePackBought(eventLog("PackBought", [packId, buyer, paid, round])), { packId, buyer: buyer.toLowerCase(), paid, round });
  }
});

test("PackRefunded decodes ethers-encoded logs", () => {
  assert.deepEqual(decodePackRefunded(eventLog("PackRefunded", [42n, ALICE, 10n ** 17n])), { packId: 42n, buyer: ALICE.toLowerCase(), amount: 10n ** 17n });
});

test("PackOpened and PackDealt decode their arrays: empty, one, five (the pack size), six (the maximum), huge ids", () => {
  const r = rng(11);
  const big = (7n << 32n) + 123n;
  const cases = [
    [[], [], []],
    [[big], [3], [3]],
    [[1n, 2n, 3n, 4n, 5n], [0, 1, 2, 3, 4], [1, 1, 2, 1, 3]],
    [Array.from({ length: 5 }, (_, i) => big + BigInt(i)), [0, 4095, 65535, 7, 11], [3, 3, 3, 3, 3]],
    [Array.from({ length: 6 }, () => randBig(r, 256)), Array.from({ length: 6 }, () => Math.floor(r() * 65536)), Array.from({ length: 6 }, () => 1 + Math.floor(r() * 3))],
    [[2n ** 256n - 1n, 0n], [0, 65535], [255, 0]],
  ];
  for (const [tokenIds, templateIds, finishes] of cases) {
    const ev = decodePackOpened(eventLog("PackOpened", [9n, BOB, tokenIds, templateIds, finishes]));
    assert.deepEqual(ev, { packId: 9n, buyer: BOB.toLowerCase(), tokenIds, templateIds, finishes });
    assert.ok(ev.templateIds.every((t) => typeof t === "number") && ev.finishes.every((f) => typeof f === "number"));
    const dealt = decodePackDealt(eventLog("PackDealt", [9n, 21_615_404n, templateIds, finishes]));
    assert.deepEqual(dealt, { packId: 9n, round: 21_615_404n, templateIds, finishes });
  }
});

test("log decoders reject the wrong event, the wrong shape and hostile data", () => {
  const opened = eventLog("PackOpened", [1n, BOB, [1n, 2n], [1, 2], [1, 3]]);
  const bought = eventLog("PackBought", [1n, BOB, 5n, 6n]);
  const dealt = eventLog("PackDealt", [1n, 6n, [1, 2], [1, 3]]);
  assert.throws(() => decodePackBought(opened), /not a PackBought/);
  assert.throws(() => decodePackOpened(bought), /not a PackOpened/);
  assert.throws(() => decodePackDealt(opened), /not a PackDealt/);
  assert.throws(() => decodePackRefunded(bought), /not a PackRefunded/);
  assert.throws(() => decodePackBought({ ...bought, topics: bought.topics.slice(0, 2) }), AbiError, "missing indexed topic");
  assert.throws(() => decodePackBought({ ...bought, topics: [...bought.topics, bought.topics[1]] }), AbiError, "extra topic");
  assert.throws(() => decodePackDealt({ ...dealt, topics: [...dealt.topics, dealt.topics[1]] }), AbiError);
  assert.throws(() => decodePackBought({ ...bought, data: bought.data.slice(0, -64) }), AbiError, "short data");
  assert.throws(() => decodePackBought({ ...bought, data: "0x" }), AbiError);
  assert.throws(() => decodePackBought({ topics: [], data: "0x" }), AbiError);
  assert.throws(() => decodePackBought(null), AbiError);
  assert.throws(() => decodePackBought({ ...bought, topics: [bought.topics[0], "0x1234", bought.topics[2]] }), AbiError, "malformed topic");
  assert.throws(() => decodePackBought({ ...bought, data: hex(5, 2n ** 64n) }), /uint64/, "a round wider than uint64");

  // hostile PackOpened payloads: every one must throw AbiError (never hang, never a RangeError)
  const withData = (h) => ({ ...opened, data: "0x" + h });
  const head = (...ns) => ns.map(w).join("");
  assert.throws(() => decodePackOpened(withData(head(0x60, 0x80, 0xa0) + w(0) + w(0))), AbiError, "third array missing its length");
  assert.throws(() => decodePackOpened(withData(head(0x61, 0x80, 0xa0) + w(0) + w(0) + w(0))), AbiError, "misaligned offset");
  assert.throws(() => decodePackOpened(withData(head(2n ** 200n, 0x80, 0xa0) + w(0) + w(0) + w(0))), AbiError, "offset far past the data");
  assert.throws(() => decodePackOpened(withData(head(0x60, 0x80, 0xa0) + w(2n ** 200n) + w(0) + w(0))), AbiError, "absurd length");
  assert.throws(() => decodePackOpened(withData(head(0x60, 0xa0, 0xe0) + w(1) + w(7) + w(1) + w(65536) + w(1) + w(1))), AbiError, "uint16 template out of range");
  assert.throws(() => decodePackOpened(withData(head(0x60, 0xa0, 0xe0) + w(1) + w(7) + w(1) + w(5) + w(1) + w(256))), AbiError, "uint8 finish out of range");
  assert.throws(() => decodePackOpened(withData(head(0x60, 0xa0, 0xe0) + w(1) + w(7) + w(1) + w(5) + w(2) + w(1) + w(1))), /differ in length/, "more finishes than cards");
  assert.throws(() => decodePackOpened(withData(head(0x60, 0xc0, 0x100) + w(2) + w(7) + w(8) + w(1) + w(5) + w(1) + w(1))), /differ in length/, "more tokens than templates");
  assert.doesNotThrow(() => decodePackOpened(withData(head(0x60, 0xa0, 0xe0) + w(1) + w(7) + w(1) + w(65535) + w(1) + w(255))));
});

test("recentPacks() result decodes: empty, one, a few, the full 16, huge values", () => {
  const r = rng(21);
  const enc = (ids, phases, rounds) => shopIface.encodeFunctionResult("recentPacks", [ids, phases, rounds]);
  const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const cases = [
    [[], [], []],
    [[1n], [1], [21_615_404n]],
    [[4n, 9n, 12n], [4, 2, 3], [100n, 200n, 300n]],
    [seq(16, (i) => BigInt(i + 1)), seq(16, (i) => i % 6), seq(16, (i) => 21_000_000n + BigInt(i) * 7n)],
    [[2n ** 256n - 1n, 0n], [5, 0], [2n ** 64n - 1n, 0n]],
    [seq(16, () => randBig(r, 256)), seq(16, () => Math.floor(r() * 6)), seq(16, () => randBig(r, 64))],
    [seq(3, () => randBig(r, 20)), [0, 255, 7], seq(3, () => randBig(r, 40))],       // the decoder bounds phases by width (uint8), not by the enum
  ];
  for (const [ids, phases, rounds] of cases) {
    const raw = enc(ids, phases, rounds);
    const d = decodeRecentPacks(raw);
    assert.deepEqual(d, { ids, phases, rounds });
    const e = shopIface.decodeFunctionResult("recentPacks", raw);                    // and ethers agrees
    assert.deepEqual([d.ids, d.phases, d.rounds], [[...e.ids], [...e.phases].map(Number), [...e.rounds]]);
  }
  const ws = words(enc([7n, 8n], [1, 2], [70n, 80n]));
  assert.equal(ws.length, 3 + 3 * 3);
  assert.deepEqual(ws.slice(0, 3).map((x) => Number(BigInt("0x" + x))), [0x60, 0xc0, 0x120], "three offsets, then three length-prefixed arrays");
});

test("recentPacks() decoder refuses hostile or broken answers with AbiError", () => {
  const good = shopIface.encodeFunctionResult("recentPacks", [[1n, 2n], [1, 2], [10n, 20n]]);
  assert.doesNotThrow(() => decodeRecentPacks(good));
  for (const [label, data] of Object.entries({
    "no data at all": "0x",
    "not hex": "nope",
    "truncated by one word": good.slice(0, -64),
    "truncated to the head": good.slice(0, 2 + 64 * 3),
    "arrays of different lengths": hex(0x60, 0xc0, 0x120, 2, 1, 2, 1, 1, 2, 2, 5, 6),
    "phases longer than ids": hex(0x60, 0xa0, 0x120, 1, 1, 2, 1, 2, 3, 1, 5),
    "misaligned offset": hex(0x61, 0xc0, 0x120, 0, 0, 0),
    "offset far past the data": hex(2n ** 200n, 0xc0, 0x120, 0, 0, 0),
    "absurd length": hex(0x60, 0x80, 0xa0, 2n ** 200n, 0, 0),
    "length past the cap": hex(0x60, 0x80, 0xa0, 5000, 0, 0),
    "array runs past the end": hex(0x60, 0x80, 0xa0, 3, 0, 0),
    "phase does not fit a uint8": hex(0x60, 0xa0, 0xe0, 1, 1, 1, 256, 1, 9),
    "round does not fit a uint64": hex(0x60, 0xa0, 0xe0, 1, 1, 1, 1, 1, 2n ** 64n),
  })) {
    assert.throws(() => decodeRecentPacks(data), AbiError, label);
  }
  assert.throws(() => decodeRecentPacks(shopIface.encodeFunctionResult("recentPacks", [[1n, 2n, 3n, 4n, 5n], [1, 1, 1, 1, 1], [1n, 1n, 1n, 1n, 1n]]), 4), /longer than 4/);
});

test("packOf() decodes a sealed pack (no cards yet), a dealt or opened one (five cards), and refuses hostile answers", () => {
  const enc = (...v) => shopIface.encodeFunctionResult("packOf", v);
  assert.deepEqual(decodePackOf(enc(ALICE, 21_615_404n, 1, 10n ** 15n, [], [])),
    { buyer: ALICE.toLowerCase(), round: 21_615_404n, phase: 1, paid: 10n ** 15n, templateIds: [], finishes: [] });
  assert.deepEqual(decodePackOf(enc(BOB, 2n ** 64n - 1n, 4, 0n, [0, 9, 65535, 3, 3], [1, 2, 3, 1, 1])),
    { buyer: BOB.toLowerCase(), round: 2n ** 64n - 1n, phase: 4, paid: 0n, templateIds: [0, 9, 65535, 3, 3], finishes: [1, 2, 3, 1, 1] });
  assert.deepEqual(decodePackOf(enc(ethers.ZeroAddress, 0n, 0, 0n, [], [])).buyer, ethers.ZeroAddress, "no such pack: the zero address");
  const ok = (round, phase, t, f) => hex(BigInt(ALICE), round, phase, 5, 0xc0, 0xe0 + 0x20 * t.length, t.length, ...t, f.length, ...f);
  assert.doesNotThrow(() => decodePackOf(ok(1, 3, [1], [2])));
  assert.throws(() => decodePackOf(ok(2n ** 64n, 3, [1], [2])), /uint64/);
  assert.throws(() => decodePackOf(ok(1, 256, [1], [2])), /uint8/);
  assert.throws(() => decodePackOf(ok(1, 3, [1, 2], [2])), /differ in length/);
  assert.throws(() => decodePackOf(ok(1, 3, [1], [256])), AbiError);
  assert.throws(() => decodePackOf(hex(BigInt(ALICE), 1, 3, 5)), AbiError, "head only");
  assert.throws(() => decodePackOf("0x"), AbiError);
});

test("pendingRounds() / finishesOf() results and the uint16[3][5] deck decode", () => {
  for (const rounds of [[], [21_615_404n], Array.from({ length: 17 }, (_, i) => 21_000_000n + BigInt(i)), [2n ** 64n - 1n]]) {
    assert.deepEqual(decodeUintArray(shopIface.encodeFunctionResult("pendingRounds", [rounds]), 64), rounds);
  }
  assert.throws(() => decodeUintArray(hex(0x20, 1, 2n ** 64n), 64), /uint64/);
  for (const fs of [[], [0], [1, 2, 3, 0, 3]]) assert.deepEqual(decodeUintArray(shopIface.encodeFunctionResult("finishesOf", [fs]), 8).map(Number), fs);
  for (const ids of [[], [(7n << 32n) + 5n, (7n << 32n) + 6n], [2n ** 256n - 1n]]) assert.deepEqual(decodeUintArray(shopIface.encodeFunctionResult("tokensOf", [ids])), ids);
  assert.throws(() => decodeUintArray(shopIface.encodeFunctionResult("finishesOf", [[1, 2, 3]]), 8, 2), /longer than 2/);
  assert.throws(() => decodeUintArray("0x", 8), AbiError, "no contract: no answer");
  const deck = [[226, 32, 8], [188, 27, 7], [152, 21, 5], [113, 16, 4], [75, 11, 3]];
  assert.deepEqual(decodeDeck(shopIface.encodeFunctionResult("deckRemaining", [deck])), deck);
  assert.deepEqual(decodeDeck(shopIface.encodeFunctionResult("deckInitial", [[[65535, 0, 1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [9, 9, 9]]])), [[65535, 0, 1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [9, 9, 9]]);
  assert.equal(words(shopIface.encodeFunctionResult("deckRemaining", [deck])).length, 15, "a static array: fifteen words, row by row");
  assert.throws(() => decodeDeck(hex(...Array(14).fill(1))), /15 words/);
  assert.throws(() => decodeDeck(hex(...Array(14).fill(1), 65536)), /uint16/);
});

test("uintArrayAt honours the length cap and bit width on its own", () => {
  const data = coder.encode(["uint256[]"], [[1n, 2n, 3n]]);          // head offset 0x20, len 3
  assert.deepEqual(uintArrayAt(words(data), 0), [1n, 2n, 3n]);
  assert.throws(() => uintArrayAt(words(data), 0, 256, 2), /longer than 2/);
  assert.throws(() => uintArrayAt(words(data), 0, 1), /does not fit in uint1/);
});

test("decodeRevert: custom errors (BeaconMissing with its round), Error(string), Panic, unknown, nothing", () => {
  for (const name of Object.keys(ERROR_SELECTORS)) {
    const d = decodeRevert(revertData(name, name === "BeaconMissing" ? [21_615_404n] : []));
    assert.equal(d.name, name);
    assert.equal(d.selector, ERROR_SELECTORS[name]);
  }
  assert.deepEqual(decodeRevert(revertData("BeaconMissing", [21_615_404n])), { selector: ERROR_SELECTORS.BeaconMissing, name: "BeaconMissing", round: 21_615_404n });
  assert.deepEqual(decodeRevert(ERROR_SELECTORS.BeaconMissing), { selector: ERROR_SELECTORS.BeaconMissing, name: "BeaconMissing", round: null }, "a truncated argument keeps the name");
  const errorString = (s) => ERROR_STRING + coder.encode(["string"], [s]).slice(2);
  for (const s of ["", "nope", "Invalid signature", "x".repeat(31), "x".repeat(32), "x".repeat(33), "y".repeat(200), "héllo ✓ 🔥"]) {
    assert.deepEqual(decodeRevert(errorString(s)), { selector: ERROR_STRING, name: "Error", reason: s });
  }
  assert.deepEqual(decodeRevert(PANIC + coder.encode(["uint256"], [0x11n]).slice(2)), { selector: PANIC, name: "Panic", code: 0x11n });
  assert.deepEqual(decodeRevert("0xdeadbeef"), { selector: "0xdeadbeef", name: null });
  assert.deepEqual(decodeRevert("0xDEADBEEF" + "00".repeat(32)), { selector: "0xdeadbeef", name: null });
  for (const none of ["0x", "0x1234", "", null, undefined, "nope", 5]) assert.equal(decodeRevert(none), null, String(none));
  // a truncated reason string keeps the name and drops the text instead of throwing
  assert.deepEqual(decodeRevert(errorString("hello world").slice(0, -64)), { selector: ERROR_STRING, name: "Error", reason: "" });
  assert.equal(decodeRevert(ERROR_STRING).reason, "");
});

test("extractRevertData finds revert bytes in every error shape a client meets", () => {
  const data = revertData("NotDealt");
  const shapes = {
    "geth / Nitro JSON-RPC error": { code: 3, message: "execution reverted", data },
    "MetaMask (nested data)": { code: -32603, message: "Internal JSON-RPC error.", data: { code: 3, message: "execution reverted", data } },
    "MetaMask (originalError)": { code: -32603, data: { originalError: { code: 3, data } } },
    "Hardhat node": { code: -32603, message: "VM Exception", data: { message: "reverted with custom error", data } },
    "ethers v6 CALL_EXCEPTION": { code: "CALL_EXCEPTION", data, info: { error: { code: 3, data } } },
    "ethers info only": { info: { error: { data } } },
    "wrapped cause": { message: "x", cause: { data } },
  };
  for (const [label, err] of Object.entries(shapes)) assert.equal(extractRevertData(err), data, label);
  assert.equal(extractRevertData(data), data, "a bare hex string");
  for (const none of [null, undefined, {}, { data: "0x" }, { data: "0x1234" }, { data: "not hex" }, { data: { data: 5 } }, 5, "0x12"]) {
    assert.equal(extractRevertData(none), null, JSON.stringify(none));
  }
  const cyclic = { message: "loop" };
  cyclic.cause = cyclic;
  cyclic.error = cyclic;
  assert.equal(extractRevertData(cyclic), null, "cyclic errors terminate");
});
