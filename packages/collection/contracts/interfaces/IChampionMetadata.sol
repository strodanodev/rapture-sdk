// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// What ChampionCollection asks of its metadata contract. The same three reads as Rapture's IRaptureMetadata, so a
/// collection can swap in its own renderer (an off-chain JSON host, a different schema) at deploy time.
interface IChampionMetadata {
    function tokenURI(uint256 tokenId) external view returns (string memory);
    /// ERC-6699 characterConfigURI (a CAIP-19 pointer to the token) and characterConfigHash (keccak256 of the
    /// image-free character.json).
    function agentConfig(uint256 tokenId) external view returns (string memory uri, bytes32 hash);
    /// Collection-level JSON (OpenSea's contractURI).
    function contractURI() external view returns (string memory);
}
