// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Traits, Origin, Design} from "../vendor/rapture/interfaces/Rapture.sol";

/// The minting interface Rapture's minters call: PackShop v1 and v2 (and the Rapture SDK's mint package) hold the
/// MINTER role on a contract with this ABI and call mintBatch. Copied verbatim from PackShop.sol, which declares it
/// against Rapture's StudioMinter; ChampionCollection implements it itself. Only the tuple layout matters to the
/// selector, so the field comments below are Rapture's names: a collection gives each field its own meaning.
/// Same ABI as StudioMinter.StudioCard (only the tuple layout matters to the selector).
struct StudioCard {
    address to;
    uint8 kind;       // 0 Mortal, 1 King, 2 Demigod, 3 Titan, 4 God
    Traits traits;
    Origin styleSource;
    Design design;
}

interface IStudioMinter {
    function mintBatch(StudioCard[] calldata cs) external returns (uint256[] memory ids);
    /// Whether `who` holds the MINTER role: PackShop must, or a paid pack could never be opened.
    function minters(address who) external view returns (bool);
    /// The stat band RaptureCards enforces for a Kind; a template outside it would revert at every open.
    function bandOf(uint8 kind) external view returns (uint16 min, uint16 max);
}
