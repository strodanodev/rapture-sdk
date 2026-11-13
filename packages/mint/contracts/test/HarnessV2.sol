// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {PackShopV2, IEvmnetRegistry, IStudioMinter} from "../PackShopV2.sol";

/// Test-only: a settable drand clock (so real past evmnet signatures can seed a pack), and a whole-deck draw
/// that measures dealing without minting hundreds of cards.
contract PackShopV2Harness is PackShopV2 {
    uint64 public roundOverride;

    constructor(IStudioMinter minter_, IEvmnetRegistry beacon_, address owner_, uint256 price_, uint8 packSize_, uint16 dailyLimit_)
        PackShopV2(minter_, beacon_, owner_, price_, packSize_, dailyLimit_)
    {}

    function setRound(uint64 r) external {
        roundOverride = r;
    }

    function currentRound() public view override returns (uint64) {
        return roundOverride != 0 ? roundOverride : super.currentRound();
    }

    /// Deal the remaining deck to empty in packs of packSize (the last one shorter), with seeds from `salt`:
    /// how many cards came out of each cell, and of each template.
    function drawAll(uint256 salt) external view returns (uint256[15] memory cells, uint256[] memory perTemplate) {
        perTemplate = new uint256[](_templates.length);
        uint256 deck = _deck;
        uint256 left = cardsLeft();
        for (uint256 p = 0; left > 0; p++) {
            uint256 n = left < packSize ? left : packSize;
            uint256 cards;
            (deck, cards) = _draw(deck, uint256(keccak256(abi.encode(salt, p))), n);
            for (uint256 i = 0; i < n; i++) {
                uint256 card = cards >> (i * 24);
                uint256 templateId = uint16(card);
                uint256 finish = uint8(card >> 16);
                cells[_templates[templateId].kind * FINISHES + finish - 1]++;
                perTemplate[templateId]++;
            }
            left -= n;
        }
    }
}

/// Test-only beacon with EvmnetRegistry's interface: accepts any non-empty "signature" and stores sha256 of it.
contract MockEvmnetRegistry is IEvmnetRegistry {
    mapping(uint64 => bytes32) public roundRandomness;
    uint256 public proofs;

    function proveRound(bytes calldata signature, uint64 roundNumber) external {
        require(signature.length > 0, "Invalid signature");
        roundRandomness[roundNumber] = sha256(signature);
        proofs++;
    }
}

/// Test-only buyer that tries to re-enter PackShopV2 while a refund pays it.
contract ReentrantBuyerV2 {
    PackShopV2 public immutable shop;
    uint256 public packId;
    bool public armed;
    bool public reenterSucceeded;
    bytes4 public lastReenterError;

    constructor(PackShopV2 shop_) {
        shop = shop_;
    }

    function buy() external payable {
        packId = shop.buyPack{value: msg.value}();
    }

    function arm() external {
        armed = true;
    }

    function refund() external {
        shop.refund(packId);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        try shop.refund(packId) {
            reenterSucceeded = true;
        } catch (bytes memory err) {
            if (err.length >= 4) lastReenterError = bytes4(err);
        }
    }
}
