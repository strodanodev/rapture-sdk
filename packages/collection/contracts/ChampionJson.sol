// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC6699} from "./vendor/rapture/interfaces/IERC6699.sol";
import {Design} from "./vendor/rapture/interfaces/Rapture.sol";
import {Champion} from "./interfaces/IChampion.sol";

/// @title ChampionJson: the stateless pieces of a champion's character.json.
///
/// Split out of ChampionMetadata so the renderer stays under the 24 KB contract limit. Every function is pure: same
/// inputs, same bytes, and src/metadata.js builds the same strings off chain. One deployment can serve any number
/// of collections.
contract ChampionJson {
    using Strings for uint256;

    string public constant SCHEMA = "rapture-sdk/champion/1";

    /// The location fields, each with its trailing comma: the only part left out of the hashed form.
    function locations(string memory base, string memory ext, Design memory d) external pure returns (string memory) {
        string memory anim = d.avatar == bytes32(0) ? "" : string.concat('"animation_url":"', base, hex64(d.avatar), '.glb",');
        return string.concat(
            '"image":"', base, hex64(d.art), ".", ext, '",', anim,
            '"external_url":"', base, hex64(d.designHash), '.json",'
        );
    }

    /// ERC-6699 play style: combat weights are each stat's share of the total, in thousandths.
    function style(IERC6699.CoreStats memory s) external pure returns (string memory) {
        uint256 total = uint256(s.strength) + s.agility + s.resilience + s.intelligence;
        if (total == 0) total = 1;
        return string.concat(
            '"style":{"combatWeights":{"aggression":', milli(uint256(s.strength) * 1000 / total),
            ',"tempo":', milli(uint256(s.agility) * 1000 / total),
            ',"defense":', milli(uint256(s.resilience) * 1000 / total),
            ',"economy":', milli(uint256(s.intelligence) * 1000 / total),
            '},"frameReactions":{"retreatBelowHealth":0.25,"engageAbove":0.6}}'
        );
    }

    /// The avatar GLB (by hash: its location is animation_url) and the SOUL.MD, each with a trailing comma, when the
    /// design has them. `requires` is a rendered JSON list of glTF extensions.
    function avatar(Design memory d, string memory requires) external pure returns (string memory out) {
        if (d.avatar != bytes32(0)) {
            string memory plain = d.avatarPlain == bytes32(0) ? "" : string.concat(
                ',"plain":{"file":"', hex64(d.avatarPlain), '.glb","sha256":"', uint256(d.avatarPlain).toHexString(32), '"}'
            );
            out = string.concat(
                '"avatar":{"schema":"erc6699-avatar/1","format":"model/gltf-binary","file":"', hex64(d.avatar),
                '.glb","sha256":"', uint256(d.avatar).toHexString(32), '","requires":', requires, plain, "},"
            );
        }
        if (d.soul != bytes32(0)) {
            out = string.concat(out, '"soul":{"format":"text/markdown","file":"', hex64(d.soul), '.md","keccak256":"', uint256(d.soul).toHexString(32), '"},');
        }
    }

    /// The collection block: every raw field, so a game reads numbers instead of parsing attribute names.
    function collectionBlock(string memory name, uint16 setId, uint256 tokenId, Champion memory c, Design memory d) external pure returns (string memory) {
        string memory head = string.concat(
            '"collection":{"schema":"', SCHEMA, '","name":"', name,
            '","setId":', uint256(setId).toString(),
            ',"tokenId":"', tokenId.toString(), '","index":', uint256(c.index).toString(),
            ',"kind":', uint256(c.kind).toString(), ',"faction":', uint256(c.faction).toString(),
            ',"alignment":', uint256(c.alignment).toString(), ',"element":', uint256(c.element).toString(),
            ',"frame":', uint256(c.frame).toString()
        );
        string memory parts = string.concat(
            ',"parts":[', uint256(c.bodyparts & 0xff).toString(), ",", uint256((c.bodyparts >> 8) & 0xff).toString(),
            ",", uint256((c.bodyparts >> 16) & 0xff).toString(), ",", uint256((c.bodyparts >> 24) & 0xff).toString(),
            '],"kit":', uint256(d.kit).toString()
        );
        return string.concat(
            head, parts,
            ',"design":{"hash":"', uint256(d.designHash).toHexString(32), '","file":"', hex64(d.designHash),
            '.json","art":"', uint256(d.art).toHexString(32), '","overrides":"', uint256(d.overridesHash).toHexString(32), '"}}'
        );
    }

    /// 64 lowercase hex digits, no 0x: a content-addressed file name.
    function hex64(bytes32 v) public pure returns (string memory) {
        bytes memory out = new bytes(64);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            out[2 * i] = digits[b >> 4];
            out[2 * i + 1] = digits[b & 0x0f];
        }
        return string(out);
    }

    /// m thousandths as "0.mmm" ("1.000" at 1000).
    function milli(uint256 m) public pure returns (string memory) {
        if (m >= 1000) return "1.000";
        string memory frac = m.toString();
        if (m < 10) frac = string.concat("00", frac);
        else if (m < 100) frac = string.concat("0", frac);
        return string.concat("0.", frac);
    }
}
