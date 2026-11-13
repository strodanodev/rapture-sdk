// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IIdentityLink} from "../vendor/rapture/interfaces/Rapture.sol";

/// Test only: an item collection to equip from.
contract TestItems is ERC721 {
    constructor() ERC721("Test Items", "ITEM") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// Test only: an identity link where one signer has a profile with a proxy wallet.
contract TestIdentity is IIdentityLink {
    address public signer;
    address public proxy;

    constructor(address signer_, address proxy_) {
        signer = signer_;
        proxy = proxy_;
    }

    function proxyOf(uint256 p) external view returns (address) {
        return p == 1 ? proxy : address(0);
    }

    function signerOf(uint256 p) external view returns (address) {
        return p == 1 ? signer : address(0);
    }

    function profileOfSigner(address who) external view returns (uint256) {
        return who == signer ? 1 : 0;
    }

    function profileOf(address who) external view returns (uint256) {
        return who == signer || who == proxy ? 1 : 0;
    }
}
