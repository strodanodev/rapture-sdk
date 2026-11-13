// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Traits, Origin, Design} from "../vendor/rapture/interfaces/Rapture.sol";

/// The minting interface a collection exposes to its shops. It is Rapture's StudioMinter ABI, unchanged: the
/// declaration PackShop v1 uses (apps/forge-site/packshop/contracts/PackShop.sol) over the shared types in
/// vendor/rapture/interfaces/Rapture.sol. A collection made with the Rapture SDK collection package exposes the same one, so both
/// minters in this package work with it and with the live Rapture collection alike.
///
/// Same ABI as StudioMinter.StudioCard (only the tuple layout matters to the selector).
struct StudioCard {
    address to;
    uint8 kind;       // 0..4 (Rapture: Mortal, King, Demigod, Titan, God)
    Traits traits;
    Origin styleSource;
    Design design;
}

interface IStudioMinter {
    /// Mint every card to its `to`. The collection numbers a batch consecutively.
    function mintBatch(StudioCard[] calldata cs) external returns (uint256[] memory ids);
    /// Whether `who` holds the MINTER role: a shop must, or a paid card could never be minted.
    function minters(address who) external view returns (bool);
    /// The stat band the collection enforces for a kind; a template outside it would revert at every mint.
    function bandOf(uint8 kind) external view returns (uint16 min, uint16 max);
}
