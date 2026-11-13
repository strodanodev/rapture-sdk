// lib/abi.js against ethers: every hard-coded selector/topic of the fixed-price minter and the collection, every encoder
// byte for byte, every decoder on ethers-made data. (The pack module's ABI has its own suite in test/packs/.)
import test from "node:test";
import assert from "node:assert/strict";
import {
  AbiError, FIXED_SELECTORS, FIXED_TOPICS, NFT_SELECTORS, ERC721_ENUMERABLE, MINTER_SELECTORS, ERROR_SELECTORS, ERROR_STRING, PANIC,
  isHex, isAddress, hexToBytes, bytesToHex, utf8ToHex, toBigInt, toQuantity, fromQuantity, encodeUint, encodeAddress, encodeBool,
  encodeBytes, encodeArgs, encodeCall, words, uintAt, uintBoundAt, addressAt, boolAt, uintArrayAt, decodeUintArray, decodeMinted,
  decodeEditions, decodeString, decodeRevert, extractRevertData, registerErrors,
} from "../web/lib/abi.js";
import { ethers, fixedIface, otherIfaces, ALICE, BOB, SHOP, revertData } from "./helpers.mjs";

const coder = ethers.AbiCoder.defaultAbiCoder();
// small deterministic PRNG so the "random" cases are the same on every run
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const randBig = (r, bits) => { let v = 0n; for (let i = 0; i < Math.ceil(bits / 32); i++) v = (v << 32n) | BigInt(Math.floor(r() * 2 ** 32)); return v & ((1n << BigInt(bits)) - 1n); };
const randBytes = (r, n) => bytesToHex(Uint8Array.from({ length: n }, () => Math.floor(r() * 256)));
const w = (n) => BigInt(n).toString(16).padStart(64, "0");
const hex = (...ns) => "0x" + ns.map(w).join("");

test("FixedPriceMinter selectors and the Minted topic equal ethers' for the compiled ABI", () => {
  for (const [name, selector] of Object.entries(FIXED_SELECTORS)) assert.equal(selector, fixedIface.getFunction(name).selector, name);
  assert.equal(FIXED_TOPICS.Minted, fixedIface.getEvent("Minted").topicHash);
  const shape = (name) => { const f = fixedIface.getFunction(name); return [f.format("sighash"), f.outputs.map((o) => o.type), f.stateMutability]; };
  assert.deepEqual(shape("mint"), ["mint(uint256,uint256)", ["uint256[]"], "payable"]);
  assert.deepEqual(shape("editionsOf"), ["editionsOf(uint256,uint256)", ["uint32[]", "uint32[]", "bool[]"], "view"]);
  assert.deepEqual(shape("templatesOf"), ["templatesOf(uint256[])", ["uint256[]"], "view"]);
  assert.deepEqual(shape("mintableBy"), ["mintableBy(address)", ["uint256"], "view"]);
  assert.deepEqual(fixedIface.getFunction("config").outputs.map((o) => o.type), ["uint256", "uint32", "bool", "bool", "bool", "uint256", "uint256", "uint256"]);
});

test("collection selectors: the minter's (StudioMinter ABI), ERC-721's and the design records' equal ethers'", () => {
  const [studioMinter, cardDesign, cards] = otherIfaces;
  for (const [name, selector] of Object.entries(MINTER_SELECTORS)) assert.equal(selector, studioMinter.getFunction(name).selector, name);
  for (const name of ["balanceOf", "ownerOf", "tokenURI", "totalSupply", "supportsInterface"]) assert.equal(NFT_SELECTORS[name], cards.getFunction(name).selector, name);
  assert.equal(NFT_SELECTORS.designOf, cardDesign.getFunction("designOf").selector);
  assert.equal(NFT_SELECTORS.tokenOfOwnerByIndex, ethers.id("tokenOfOwnerByIndex(address,uint256)").slice(0, 10));
  const erc721Enumerable = ["totalSupply()", "tokenOfOwnerByIndex(address,uint256)", "tokenByIndex(uint256)"].map((f) => BigInt(ethers.id(f).slice(0, 10))).reduce((a, b) => a ^ b);
  assert.equal(ERC721_ENUMERABLE, "0x" + erc721Enumerable.toString(16).padStart(8, "0"));
});

test("error selectors equal ethers' (the fixed minter, OpenZeppelin, and the reference collection)", () => {
  const all = [fixedIface, ...otherIfaces];
  for (const [name, selector] of Object.entries(ERROR_SELECTORS)) {
    const frag = all.map((i) => i.getError(name)).find(Boolean);
    assert.ok(frag, `${name} is not in any compiled ABI`);
    assert.equal(selector, frag.selector, name);
  }
  for (const name of ["SoldOut", "WrongPayment", "WalletLimitReached", "UnknownTemplate", "BadQuantity", "NotMinter", "EnforcedPause"]) {
    assert.ok(ERROR_SELECTORS[name], `${name} missing from ERROR_SELECTORS`);
  }
  assert.equal(ERROR_STRING, ethers.id("Error(string)").slice(0, 10));
  assert.equal(PANIC, ethers.id("Panic(uint256)").slice(0, 10));
});

test("fixed-price encoders: calldata is byte-identical to ethers.Interface.encodeFunctionData", () => {
  const r = rng(11);
  for (let i = 0; i < 30; i++) {
    const id = randBig(r, 32), q = randBig(r, 4);
    assert.equal(encodeCall(FIXED_SELECTORS.mint, ["uint256", "uint256"], [id, q]), fixedIface.encodeFunctionData("mint", [id, q]));
    assert.equal(encodeCall(FIXED_SELECTORS.editionsOf, ["uint256", "uint256"], [id, 256]), fixedIface.encodeFunctionData("editionsOf", [id, 256]));
  }
  for (const a of [ALICE, ALICE.toLowerCase(), BOB, SHOP]) {
    assert.equal(encodeCall(FIXED_SELECTORS.mintableBy, ["address"], [a]), fixedIface.encodeFunctionData("mintableBy", [ethers.getAddress(a.toLowerCase())]));
  }
  for (const ids of [[], [1n], [2n ** 32n, 2n ** 32n + 1n, 2n ** 256n - 1n], Array.from({ length: 50 }, (_, i) => BigInt(i) << 32n)]) {
    assert.equal(encodeCall(FIXED_SELECTORS.templatesOf, ["uint256[]"], [ids]), fixedIface.encodeFunctionData("templatesOf", [ids]));
  }
  for (const b of ["0x", "0x01", randBytes(r, 31), randBytes(r, 32), randBytes(r, 33), randBytes(r, 64)]) {
    assert.equal("0x" + encodeArgs(["bytes"], [b]), coder.encode(["bytes"], [b]));
    assert.equal("0x" + encodeArgs(["bytes[]"], [[b, b]]), coder.encode(["bytes[]"], [[b, b]]));
  }
});

test("fixed-price decoders read ethers-made results and logs, and refuse hostile ones", () => {
  const data = fixedIface.encodeFunctionResult("editionsOf", [[5, 3, 10], [0, 3, 2], [false, false, true]]);
  assert.deepEqual(decodeEditions(data), { maxSupply: [5, 3, 10], minted: [0, 3, 2], retired: [false, false, true] });
  assert.deepEqual(decodeEditions(fixedIface.encodeFunctionResult("editionsOf", [[], [], []])), { maxSupply: [], minted: [], retired: [] });
  assert.throws(() => decodeEditions(coder.encode(["uint32[]", "uint32[]", "bool[]"], [[1, 2], [0], [false, false]])), AbiError);
  assert.deepEqual(decodeUintArray(fixedIface.encodeFunctionResult("templatesOf", [[0n, 4n, 2n ** 200n]])), [0n, 4n, 2n ** 200n]);
  const ids = [2n ** 32n, 2n ** 32n + 1n];
  const log = fixedIface.encodeEventLog("Minted", [ALICE, BOB, 7n, ids, 10n ** 15n]);
  assert.deepEqual(decodeMinted(log), { payer: ALICE.toLowerCase(), to: BOB.toLowerCase(), templateId: 7, tokenIds: ids, paid: 10n ** 15n });
  assert.throws(() => decodeMinted({ ...log, topics: log.topics.slice(0, 3) }), AbiError);
  assert.throws(() => decodeMinted({ ...log, topics: [ethers.ZeroHash, ...log.topics.slice(1)] }), AbiError);
  for (const text of ["", "ipfs://bafy/1.json", "data:application/json;base64,eyJ9", "é".repeat(40)]) {
    assert.equal(decodeString(coder.encode(["string"], [text])), text);
  }
  assert.throws(() => decodeString(coder.encode(["string"], ["x".repeat(100)]), 10), AbiError);
});

test("decodeRevert: the site's errors by name, Error(string), Panic, unknown, nothing; registerErrors adds more", () => {
  for (const name of Object.keys(ERROR_SELECTORS)) {
    const d = decodeRevert(revertData(name));
    assert.equal(d.name, name);
    assert.equal(d.selector, ERROR_SELECTORS[name]);
  }
  const errorString = (s) => ERROR_STRING + coder.encode(["string"], [s]).slice(2);
  for (const s of ["", "nope", "x".repeat(33), "héllo ✓ 🔥"]) assert.deepEqual(decodeRevert(errorString(s)), { selector: ERROR_STRING, name: "Error", reason: s });
  assert.deepEqual(decodeRevert(PANIC + coder.encode(["uint256"], [0x11n]).slice(2)), { selector: PANIC, name: "Panic", code: 0x11n });
  assert.deepEqual(decodeRevert("0xdeadbeef"), { selector: "0xdeadbeef", name: null });
  for (const none of ["0x", "0x1234", "", null, undefined, "nope", 5]) assert.equal(decodeRevert(none), null, String(none));
  assert.deepEqual(decodeRevert(errorString("hello world").slice(0, -64)), { selector: ERROR_STRING, name: "Error", reason: "" });
  // a module's own error, with an argument decoder (as the pack module registers its errors)
  const sel = ethers.id("Waiting(uint64)").slice(0, 10);
  registerErrors({ Waiting: sel }, { Waiting: (ws) => { try { return { round: uintBoundAt(ws, 0, 64) }; } catch { return { round: null }; } } });
  assert.deepEqual(decodeRevert(sel + w(42)), { selector: sel, name: "Waiting", round: 42n });
  assert.deepEqual(decodeRevert(sel), { selector: sel, name: "Waiting", round: null });
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

test("uintArrayAt honours the length cap and bit width on its own", () => {
  const data = coder.encode(["uint256[]"], [[1n, 2n, 3n]]);          // head offset 0x20, len 3
  assert.deepEqual(uintArrayAt(words(data), 0), [1n, 2n, 3n]);
  assert.throws(() => uintArrayAt(words(data), 0, 256, 2), /longer than 2/);
  assert.throws(() => uintArrayAt(words(data), 0, 1), /does not fit in uint1/);
});

test("extractRevertData finds revert bytes in every error shape a client meets", () => {
  const data = revertData("SoldOut");
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

