// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PackShopV2} from "../PackShopV2.sol";

/// Test-only actors for test/review/adversarial-v2.test.js (the PackShopV2 adversarial review). Never deployed anywhere.

/// A buyer contract whose receive() re-enters the shop with a scripted list of calls (once), and whose
/// onERC721Received can refuse NFTs. Records the revert selector of every re-entry attempt.
contract AdversaryV2 {
    PackShopV2 public immutable shop;
    uint256 public lastPackId;
    bool public armed;
    bool public rejectNfts;
    bytes[] internal _calls;
    uint256[] internal _values;
    bytes4[] internal _errors;
    uint256 public successes;
    uint256 public received;

    constructor(PackShopV2 shop_) {
        shop = shop_;
    }

    function buy() external payable returns (uint256) {
        lastPackId = shop.buyPack{value: msg.value}();
        return lastPackId;
    }

    function arm(bytes[] calldata calls, uint256[] calldata values) external {
        delete _calls;
        delete _values;
        delete _errors;
        for (uint256 i = 0; i < calls.length; i++) {
            _calls.push(calls[i]);
            _values.push(values[i]);
        }
        armed = true;
    }

    function setRejectNfts(bool on) external {
        rejectNfts = on;
    }

    /// Call the shop as this contract (e.g. refund(), which only the buyer may call). Bubbles the revert.
    function exec(bytes calldata data) external payable returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(shop).call{value: msg.value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function errors() external view returns (bytes4[] memory) {
        return _errors;
    }

    receive() external payable {
        received += msg.value;
        if (!armed) return;
        armed = false;
        for (uint256 i = 0; i < _calls.length; i++) {
            (bool ok, bytes memory ret) = address(shop).call{value: _values[i]}(_calls[i]);
            if (ok) successes++;
            else _errors.push(ret.length >= 4 ? bytes4(ret) : bytes4(0));
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (rejectNfts) revert("no NFTs here");
        return this.onERC721Received.selector;
    }
}

/// A contract buyer with no way to call anything but buyPack (a minimal router or game contract): since refunds are
/// buyer-only, nobody can ever refund its packs.
contract PlainBuyerV2 {
    PackShopV2 public immutable shop;
    uint256 public lastPackId;

    constructor(PackShopV2 shop_) {
        shop = shop_;
    }

    function buy() external payable returns (uint256) {
        lastPackId = shop.buyPack{value: msg.value}();
        return lastPackId;
    }

    receive() external payable {}
}

/// Conditional buyer: buy, prove the pack's round, deal through its own pack and read it, all in ONE transaction,
/// reverting (so paying nothing) unless the pull holds a card of `minFinish` or better. Only works if the round the
/// shop binds is already public, i.e. the chain clock lags drand.
contract LagSniperV2 {
    PackShopV2 public immutable shop;

    constructor(PackShopV2 shop_) {
        shop = shop_;
    }

    function snipe(uint64[] calldata rounds, bytes[] calldata sigs, uint8 minFinish) external payable returns (uint256 packId) {
        packId = shop.buyPack{value: msg.value}();
        shop.deal(type(uint256).max, rounds, sigs);
        (,, PackShopV2.Phase phase,,, uint8[] memory finishes) = shop.packOf(packId);
        require(phase == PackShopV2.Phase.Dealt, "cannot see the pull");
        for (uint256 i = 0; i < finishes.length; i++) {
            if (finishes[i] >= minFinish) return packId;
        }
        revert("bad pull, try again");
    }
}
