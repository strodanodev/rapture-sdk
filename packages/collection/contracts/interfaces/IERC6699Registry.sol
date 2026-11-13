// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {IERC6699} from "../vendor/rapture/interfaces/IERC6699.sol";

/// The part of LitNode's ERC6699Registry (v2) a collection uses: the write side of the mirror, plus the reads a
/// deploy script needs to tell the builder whether the registry admin has approved the collection yet. Rapture's
/// registry and LitNode's are the same contract, so this interface fits both.
interface IERC6699Registry {
    function forge(uint256 tokenId, address owner, IERC6699.CoreStats calldata s, IERC6699.AgentManifest calldata m) external;
    function setController(uint256 tokenId, address controller) external;
    function setManifest(uint256 tokenId, string calldata uri, bytes32 soulManifestHash, bytes32 characterConfigHash) external;

    function admin() external view returns (address);
    function minters(address who) external view returns (bool);
    function ownerOf(uint256 tokenId) external view returns (address);
}
