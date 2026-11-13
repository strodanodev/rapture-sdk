// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC6699} from "../vendor/rapture/interfaces/IERC6699.sol";
import {Origin, Design} from "../vendor/rapture/interfaces/Rapture.sol";

/// The value ranges a champion's fields may take. Every field of the StudioCard tuple has a slot here, so one
/// template serves any collection: a collection that does not use a field leaves its max at 0 (and its label empty
/// in the metadata vocabulary). Rapture ARC 1 is one configuration of it (examples/rapture/collection.json).
struct Rules {
    uint8 kinds;           // how many Kinds (tiers) there are, 1..16: a card's kind is 0..kinds-1
    uint8 maxFaction;      // traits.faction is 0..maxFaction
    uint8 maxAlignment;    // traits.alignment is 0..maxAlignment ...
    bool sealedAlignment;  // ... or 255 (sealed), when this is set
    uint8 maxElement;      // traits.element is 0..maxElement
    uint8 maxFrame;        // traits.frame is 0..maxFrame
    uint8[4] maxParts;     // traits.bodyparts = p0 | p1 << 8 | p2 << 16 | p3 << 24, each p_i in 0..maxParts[i]
    uint8 maxKit;          // design.kit is 0 (none) or 1..maxKit
    uint16 kitKinds;       // bit k set: a Kind k card must name a kit; clear: it must name none
    bool requireAvatar;    // every design must carry an avatar GLB hash (and its plain twin)
}

/// One champion's on-chain record (its stats are ERC-6699 CoreStats, its art and names its Design).
struct Champion {
    uint32 index;          // position in the collection, 0-based: tokenId = setId << 32 | index
    uint8 kind;
    uint8 faction;
    uint8 alignment;
    uint8 element;
    uint8 frame;
    uint32 bodyparts;
    bool mirrored;         // its twin exists in the ERC6699Registry
    address minter;        // the MINTER that minted it (a team key, a PackShop, a fixed-price minter)
}

/// The reads ChampionMetadata renders a token from.
interface IChampionView {
    function name() external view returns (string memory);
    function setId() external view returns (uint16);
    function nextIndex() external view returns (uint32);
    function championOf(uint256 tokenId) external view returns (Champion memory);
    function designOf(uint256 tokenId) external view returns (Design memory);
    function originOf(uint256 tokenId) external view returns (Origin memory);
    function coreStats(uint256 tokenId) external view returns (IERC6699.CoreStats memory);
}
