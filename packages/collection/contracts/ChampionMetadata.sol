// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {IERC6699} from "./vendor/rapture/interfaces/IERC6699.sol";
import {Origin, Design} from "./vendor/rapture/interfaces/Rapture.sol";
import {IChampionMetadata} from "./interfaces/IChampionMetadata.sol";
import {IChampionView, Champion} from "./interfaces/IChampion.sol";

/// @title ChampionMetadata: each champion's character.json, built on chain. No metadata server, no pinning service.
///
/// Generalised from Rapture's RaptureMetadata: the trait vocabulary (labels and value names) is the collection's own,
/// set by the admin before the first mint and fixed from then on.
///   tokenURI            data: URI of the full JSON, locations included (wallets, marketplaces)
///   agentConfig().uri   CAIP-19 pointer to the token, eip155:<chain>/erc721:<collection>/<id>
///   agentConfig().hash  keccak256 of the LOCATION-FREE JSON: the full JSON minus "image", "animation_url" and
///                       "external_url". It is fixed at mint, so the hash the registry twin holds never drifts when
///                       the image base moves from a gateway to the final IPFS directory.
///
/// Files are addressed by content hash under the image base: <imageBase><sha256(art)>.<artExt>,
/// <imageBase><sha256(avatar)>.glb and <imageBase><designHash>.json (the design document). The SDK's metadata
/// pipeline (src/metadata.js) builds byte-identical JSON off chain, and its tests check that against this contract.
/// The image base may change until freezeImages(); after that nothing here can change.
contract ChampionMetadata is IChampionMetadata {
    using Strings for uint256;

    string public constant SCHEMA = "rapture-sdk/champion/1";
    uint8 internal constant SEALED = 255;

    /// A trait's attribute label ("" hides it) and the names of its values (value i -> values[i]; a value without a
    /// name renders as its number).
    struct Trait {
        string label;
        string[] values;
    }

    /// The six traits, by index (setTrait / traitOf). Kit k (1-based) names itself values[k - 1].
    uint8 public constant KIND = 0;
    uint8 public constant FACTION = 1;
    uint8 public constant ALIGNMENT = 2;
    uint8 public constant ELEMENT = 3;
    uint8 public constant FRAME = 4;
    uint8 public constant KIT = 5;

    IChampionView public collection;
    address public admin;
    string public imageBase;   // e.g. ipfs://<CID>/
    string public artExt;      // the art's file extension: webp, png
    bool public frozen;

    string public description;     // collection-level (contractURI)
    string public image;
    string public externalLink;

    /// The vocabulary: part of every token's hashed JSON, so it is locked once the first token exists.
    string public tagline;          // the bio after the epithet: "A champion of the Rapture."
    string public sealedLabel;      // what alignment 255 shows as
    Trait[6] internal _traits;
    string[4] internal _parts;      // labels of the bodyparts bytes p0..p3; "" = unused
    string[] internal _avatarRequires;  // glTF extensions the avatar GLB needs (["KHR_draco_mesh_compression"])
    string[] internal _equipmentSlots;  // ERC-6699 boundaries.equipmentSlots

    event CollectionBound(address collection);
    event VocabularySet();
    event ImageBaseSet(string base, string ext);
    event ImagesFrozen();
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error ZeroAddress();
    error Frozen();
    error AlreadyBound();
    error NoCode();
    error Locked();
    error BadText();

    constructor(address admin_, string memory imageBase_, string memory artExt_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        _setImageBase(imageBase_, artExt_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    // ------------------------------------------------------------------ admin

    function bindCollection(IChampionView collection_) external onlyAdmin {
        if (address(collection) != address(0)) revert AlreadyBound();
        if (address(collection_).code.length == 0) revert NoCode();
        collection = collection_;
        emit CollectionBound(address(collection_));
    }

    modifier unlocked() {
        if (address(collection) != address(0) && collection.nextIndex() != 0) revert Locked();
        _;
    }

    /// One trait's attribute label ("" hides it) and value names (KIND, FACTION, ALIGNMENT, ELEMENT, FRAME, KIT).
    function setTrait(uint8 which, string calldata label, string[] calldata values) external onlyAdmin unlocked {
        if (which > KIT) revert BadText();
        _checkJson(label, 0, 48);
        _traits[which].label = label;
        _copyList(_traits[which].values, values);
        emit VocabularySet();
    }

    /// The bio line, the sealed-alignment name and the labels of the four bodyparts bytes ("" = unused).
    function setLabels(string calldata tagline_, string calldata sealedLabel_, string[4] calldata parts) external onlyAdmin unlocked {
        _checkJson(tagline_, 0, 160);
        _checkJson(sealedLabel_, 0, 48);
        tagline = tagline_;
        sealedLabel = sealedLabel_;
        for (uint256 i = 0; i < 4; i++) {
            _checkJson(parts[i], 0, 48);
            _parts[i] = parts[i];
        }
        emit VocabularySet();
    }

    /// The avatar GLB's required glTF extensions and the ERC-6699 equipment slots.
    function setLists(string[] calldata avatarRequires_, string[] calldata equipmentSlots_) external onlyAdmin unlocked {
        _copyList(_avatarRequires, avatarRequires_);
        _copyList(_equipmentSlots, equipmentSlots_);
        emit VocabularySet();
    }

    /// Collection-level metadata (contractURI). Not part of any token's hash, so it may change until frozen.
    function setCollectionInfo(string calldata description_, string calldata image_, string calldata externalLink_) external onlyAdmin {
        if (frozen) revert Frozen();
        _checkJson(description_, 0, 1000);
        _checkJson(image_, 0, 512);
        _checkJson(externalLink_, 0, 512);
        description = description_;
        image = image_;
        externalLink = externalLink_;
    }

    function setImageBase(string calldata base, string calldata ext) external onlyAdmin {
        if (frozen) revert Frozen();
        _setImageBase(base, ext);
    }

    function freezeImages() external onlyAdmin {
        frozen = true;
        emit ImagesFrozen();
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, to);
        admin = to;
    }

    function traitOf(uint8 which) external view returns (string memory label, string[] memory values) {
        return (_traits[which].label, _traits[which].values);
    }

    function partLabels() external view returns (string[4] memory) {
        return _parts;
    }

    function lists() external view returns (string[] memory avatarRequires, string[] memory equipmentSlots) {
        return (_avatarRequires, _equipmentSlots);
    }

    // ------------------------------------------------------------------ reads

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return string.concat("data:application/json;base64,", Base64.encode(bytes(characterJson(tokenId, true))));
    }

    function agentConfig(uint256 tokenId) external view returns (string memory uri, bytes32 hash) {
        uri = string.concat("eip155:", block.chainid.toString(), "/erc721:", Strings.toHexString(address(collection)), "/", tokenId.toString());
        hash = keccak256(bytes(characterJson(tokenId, false)));
    }

    function contractURI() external view returns (string memory) {
        string memory name = address(collection) == address(0) ? "" : collection.name();
        return string.concat(
            "data:application/json;base64,",
            Base64.encode(bytes(string.concat(
                '{"name":"', name, '","description":"', description, '","image":"', image, '","external_link":"', externalLink, '"}'
            )))
        );
    }

    /// The location-free form is the full form minus "image", "animation_url" and "external_url" (each with its
    /// trailing comma), so a reader can recompute characterConfigHash from tokenURI alone.
    function characterJson(uint256 tokenId, bool withLocations) public view returns (string memory) {
        Champion memory c = collection.championOf(tokenId);
        Design memory d = collection.designOf(tokenId);
        IERC6699.CoreStats memory s = collection.coreStats(tokenId);
        string memory bio = _bio(d.epithet);
        return string.concat(
            '{"name":"', d.name, '","bio":"', bio, '","description":"', bio, '",',
            withLocations ? _locations(d) : "",
            _style(s), ',"boundaries":{"equipmentSlots":', _list(_equipmentSlots), '},',
            _avatarJson(d),
            _attributes(c, s, d, collection.originOf(tokenId)), ',',
            _block(c, tokenId, d), '}'
        );
    }

    // ------------------------------------------------------------------ pieces

    function _bio(string memory epithet) internal view returns (string memory) {
        if (bytes(epithet).length == 0) return tagline;
        if (bytes(tagline).length == 0) return epithet;
        return string.concat(epithet, ". ", tagline);
    }

    function _locations(Design memory d) internal view returns (string memory) {
        string memory anim = d.avatar == bytes32(0) ? "" : string.concat('"animation_url":"', imageBase, _hex(d.avatar), '.glb",');
        return string.concat(
            '"image":"', imageBase, _hex(d.art), '.', artExt, '",', anim,
            '"external_url":"', imageBase, _hex(d.designHash), '.json",'
        );
    }

    function _style(IERC6699.CoreStats memory s) internal pure returns (string memory) {
        uint256 total = uint256(s.strength) + s.agility + s.resilience + s.intelligence;
        if (total == 0) total = 1;
        return string.concat(
            '"style":{"combatWeights":{"aggression":', _milli(uint256(s.strength) * 1000 / total),
            ',"tempo":', _milli(uint256(s.agility) * 1000 / total),
            ',"defense":', _milli(uint256(s.resilience) * 1000 / total),
            ',"economy":', _milli(uint256(s.intelligence) * 1000 / total),
            '},"frameReactions":{"retreatBelowHealth":0.25,"engageAbove":0.6}}'
        );
    }

    /// The avatar GLB (by hash: its location is animation_url) and the SOUL.MD, when the design has them.
    function _avatarJson(Design memory d) internal view returns (string memory out) {
        if (d.avatar != bytes32(0)) {
            string memory plain = d.avatarPlain == bytes32(0) ? "" : string.concat(
                ',"plain":{"file":"', _hex(d.avatarPlain), '.glb","sha256":"', uint256(d.avatarPlain).toHexString(32), '"}'
            );
            out = string.concat(
                '"avatar":{"schema":"erc6699-avatar/1","format":"model/gltf-binary","file":"', _hex(d.avatar),
                '.glb","sha256":"', uint256(d.avatar).toHexString(32), '","requires":', _list(_avatarRequires), plain, '},'
            );
        }
        if (d.soul != bytes32(0)) {
            out = string.concat(out, '"soul":{"format":"text/markdown","file":"', _hex(d.soul), '.md","keccak256":"', uint256(d.soul).toHexString(32), '"},');
        }
    }

    function _attributes(Champion memory c, IERC6699.CoreStats memory s, Design memory d, Origin memory o) internal view returns (string memory) {
        string memory a = _trait("", KIND, c.kind);
        a = _trait(a, FACTION, c.faction);
        a = c.alignment == SEALED ? _attr(a, _traits[ALIGNMENT].label, sealedLabel) : _trait(a, ALIGNMENT, c.alignment);
        a = _trait(a, ELEMENT, c.element);
        a = _trait(a, FRAME, c.frame);
        for (uint256 i = 0; i < 4; i++) {
            if (bytes(_parts[i]).length != 0) a = _num(a, _parts[i], (c.bodyparts >> (8 * i)) & 0xff, false);
        }
        if (bytes(d.epithet).length != 0) a = _attr(a, "Epithet", d.epithet);
        if (d.kit != 0) a = _trait(a, KIT, d.kit - 1);
        a = _num(a, "Strength", s.strength, true);
        a = _num(a, "Agility", s.agility, true);
        a = _num(a, "Resilience", s.resilience, true);
        a = _num(a, "Intelligence", s.intelligence, true);
        if (o.collection != address(0)) {
            a = _attr(a, "Origin", string.concat("eip155:", uint256(o.chainId).toString(), "/erc721:", Strings.toHexString(o.collection), "/", o.tokenId.toString()));
        }
        return string.concat('"attributes":[', a, "]");
    }

    function _block(Champion memory c, uint256 tokenId, Design memory d) internal view returns (string memory) {
        string memory head = string.concat(
            '"collection":{"schema":"', SCHEMA, '","name":"', collection.name(),
            '","setId":', uint256(collection.setId()).toString(),
            ',"tokenId":"', tokenId.toString(), '","index":', uint256(c.index).toString(),
            ',"kind":', uint256(c.kind).toString(), ',"faction":', uint256(c.faction).toString(),
            ',"alignment":', uint256(c.alignment).toString(), ',"element":', uint256(c.element).toString(),
            ',"frame":', uint256(c.frame).toString()
        );
        string memory parts = string.concat(
            ',"parts":[', uint256(c.bodyparts & 0xff).toString(), ',', uint256((c.bodyparts >> 8) & 0xff).toString(),
            ',', uint256((c.bodyparts >> 16) & 0xff).toString(), ',', uint256((c.bodyparts >> 24) & 0xff).toString(),
            '],"kit":', uint256(d.kit).toString()
        );
        return string.concat(
            head, parts,
            ',"design":{"hash":"', uint256(d.designHash).toHexString(32), '","file":"', _hex(d.designHash),
            '.json","art":"', uint256(d.art).toHexString(32), '","overrides":"', uint256(d.overridesHash).toHexString(32), '"}}'
        );
    }

    function _attr(string memory acc, string memory label, string memory value) internal pure returns (string memory) {
        if (bytes(label).length == 0) return acc;
        string memory piece = string.concat('{"trait_type":"', label, '","value":"', value, '"}');
        return bytes(acc).length == 0 ? piece : string.concat(acc, ",", piece);
    }

    function _num(string memory acc, string memory label, uint256 value, bool display) internal pure returns (string memory) {
        string memory piece = string.concat('{"trait_type":"', label, '","value":', value.toString(), display ? ',"display_type":"number"}' : "}");
        return bytes(acc).length == 0 ? piece : string.concat(acc, ",", piece);
    }

    /// A trait attribute: value i's name, or its number when it has none.
    function _trait(string memory acc, uint8 which, uint256 i) internal view returns (string memory) {
        Trait storage t = _traits[which];
        return _attr(acc, t.label, i < t.values.length ? t.values[i] : i.toString());
    }

    function _list(string[] storage xs) internal view returns (string memory out) {
        out = "[";
        for (uint256 i = 0; i < xs.length; i++) out = string.concat(out, i == 0 ? '"' : ',"', xs[i], '"');
        out = string.concat(out, "]");
    }

    function _hex(bytes32 v) internal pure returns (string memory) {
        bytes memory out = new bytes(64);
        bytes16 digits = "0123456789abcdef";
        for (uint256 i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            out[2 * i] = digits[b >> 4];
            out[2 * i + 1] = digits[b & 0x0f];
        }
        return string(out);
    }

    function _milli(uint256 m) internal pure returns (string memory) {
        if (m >= 1000) return "1.000";
        string memory frac = m.toString();
        if (m < 10) frac = string.concat("00", frac);
        else if (m < 100) frac = string.concat("0", frac);
        return string.concat("0.", frac);
    }

    // ------------------------------------------------------------------ setters' checks

    function _setImageBase(string memory base, string memory ext) internal {
        _checkJson(base, 0, 512);
        bytes memory e = bytes(ext);
        if (e.length == 0 || e.length > 8) revert BadText();
        for (uint256 i = 0; i < e.length; i++) {
            bytes1 c = e[i];
            if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x7a))) revert BadText();
        }
        imageBase = base;
        artExt = ext;
        emit ImageBaseSet(base, ext);
    }

    function _copyList(string[] storage dst, string[] calldata src) internal {
        if (src.length > 64) revert BadText();
        while (dst.length != 0) dst.pop();
        for (uint256 i = 0; i < src.length; i++) {
            _checkJson(src[i], 1, 48);
            dst.push(src[i]);
        }
    }

    /// Printable ASCII without '"' and '\': safe unescaped inside a JSON string.
    function _checkJson(string memory s, uint256 minLen, uint256 maxLen) internal pure {
        bytes memory b = bytes(s);
        if (b.length < minLen || b.length > maxLen) revert BadText();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) revert BadText();
        }
    }
}
