// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC6699} from "./vendor/rapture/interfaces/IERC6699.sol";
import {Traits, Origin, Design, IIdentityLink} from "./vendor/rapture/interfaces/Rapture.sol";
import {StudioCard, IStudioMinter} from "./interfaces/IStudioMinter.sol";
import {IERC6699Registry} from "./interfaces/IERC6699Registry.sol";
import {IChampionMetadata} from "./interfaces/IChampionMetadata.sol";
import {Rules, Champion} from "./interfaces/IChampion.sol";

/// @title ChampionCollection: an ERC-721 whose tokens are playable ERC-6699 champions.
///
/// The Rapture SDK's collection template, generalised from Rapture's RaptureCards + StudioMinter + CardDesign:
///   - a full ERC-721 that implements the proposed ERC-6699 character interface (CoreStats, manifest, equipment);
///   - it IS the minter: it implements the IStudioMinter ABI that PackShop v1/v2 and the SDK's fixed-price minter
///     call (mintBatch, minters, bandOf), so any of them sells this collection unchanged once the admin grants it
///     the MINTER role with setMinter;
///   - every token is MIRRORED into an EXISTING ERC6699Registry (LitNode's canonical one, or Rapture's), passed to
///     the constructor. This contract never deploys a registry: a collection with its own registry is invisible to
///     LitNode, which reads one registry fleet-wide.
///
/// The mirror. The token's twin in the registry has id registryIdOf(tokenId), this contract as owner (the ERC-721
/// is what trades) and the holder as agentController, so LitNode accepts the holder for ranked play. Every transfer
/// re-points the controller. Forging needs the registry admin's approval (registry.setMinter(this, true)); until it
/// comes, mints still succeed and each token is left MirrorPending. After approval anyone calls mirror(ids) once.
///
/// Fair-launch invariants: no stat or trait changes after mint (no progressor, no admin write path, not
/// upgradeable); stats sit inside their Kind's band; supply is capped by maxSupply (0 = uncapped).
contract ChampionCollection is ERC721, IERC6699, IStudioMinter {
    uint8 public constant SEALED = 255;
    uint256 public constant MAX_SLOTS = 8;
    uint256 public constant MAX_KINDS = 16;

    /// The registry every token mirrors into. Immutable: moving it would orphan every twin.
    IERC6699Registry public immutable registry;
    IChampionMetadata public immutable metadata;
    /// Optional identity link (LitNode PlayerProfile proxies): a linked signer's tokens are played by its proxy.
    /// Zero: every holder controls its own tokens.
    IIdentityLink public immutable identity;
    /// tokenId = setId << 32 | index: readable, unique across a builder's collections, never 0.
    uint16 public immutable setId;
    /// 0 = no cap.
    uint32 public immutable maxSupply;

    address public admin;
    mapping(address => bool) public override minters;
    uint32 public nextIndex;
    uint256 public totalSupply;
    /// Tokens minted before the registry approved this collection, not mirrored yet.
    uint256 public pendingMirrors;

    Rules private _rules;
    uint16[] private _min;
    uint16[] private _max;

    mapping(uint256 => Champion) private _champions;
    mapping(uint256 => CoreStats) private _stats;
    mapping(uint256 => Design) private _designs;
    mapping(uint256 => Origin) private _origin;
    mapping(uint256 => address) private _controller;
    mapping(uint256 => bytes32) private _soul;
    mapping(uint256 => uint64) private _manifestNonce;
    mapping(uint256 => bytes32[]) private _slots;
    mapping(uint256 => mapping(bytes32 => address)) private _slotCollection;
    mapping(uint256 => mapping(bytes32 => uint256)) private _slotAsset;

    event MinterSet(address indexed who, bool on);
    event AdminTransferred(address indexed from, address indexed to);
    event ChampionMinted(uint256 indexed tokenId, address indexed to, address indexed minter, bytes32 designHash);
    event Mirrored(uint256 indexed tokenId, uint256 indexed registryId);
    event MirrorPending(uint256 indexed tokenId);
    event ControllerSet(uint256 indexed tokenId, address controller);

    error ZeroAddress();
    error NotAdmin();
    error NotMinter();
    error NoCode(address what);
    error BadSetId();
    error BadName();
    error BadRules();
    error BadBand();
    error BadKind();
    error BadTraits();
    error BadParts();
    error BadKit();
    error BadDesign();
    error OutOfBand();
    error SoldOut();
    error EmptyBatch();
    error NotApproved();
    error AlreadyMirrored(uint256 tokenId);
    error NotController();
    error NotOwner();
    error ItemNotOwned();
    error TooManySlots();

    constructor(
        string memory name_,
        string memory symbol_,
        uint16 setId_,
        IERC6699Registry registry_,
        IChampionMetadata metadata_,
        IIdentityLink identity_,
        address admin_,
        uint32 maxSupply_,
        Rules memory rules_,
        uint16[] memory statMin,
        uint16[] memory statMax
    ) ERC721(name_, symbol_) {
        // a typo'd registry would mint champions LitNode can never see: it must be a deployed contract
        if (address(registry_).code.length == 0) revert NoCode(address(registry_));
        if (address(metadata_).code.length == 0) revert NoCode(address(metadata_));
        if (address(identity_) != address(0) && address(identity_).code.length == 0) revert NoCode(address(identity_));
        if (admin_ == address(0)) revert ZeroAddress();
        if (setId_ == 0) revert BadSetId();
        _checkJson(name_, 1, 64);
        _checkJson(symbol_, 1, 16);
        if (rules_.kinds == 0 || rules_.kinds > MAX_KINDS) revert BadRules();
        if (rules_.kitKinds >> rules_.kinds != 0) revert BadRules();        // a bit for a Kind that does not exist
        if (rules_.maxKit == 0 && rules_.kitKinds != 0) revert BadRules();  // a Kind that must name a kit, and no kits
        if (rules_.maxAlignment == SEALED) revert BadRules();
        if (statMin.length != rules_.kinds || statMax.length != rules_.kinds) revert BadBand();
        for (uint256 k = 0; k < statMin.length; k++) {
            if (statMin[k] == 0 || statMin[k] > statMax[k]) revert BadBand();
        }
        registry = registry_;
        metadata = metadata_;
        identity = identity_;
        setId = setId_;
        maxSupply = maxSupply_;
        admin = admin_;
        _rules = rules_;
        _min = statMin;
        _max = statMax;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender]) revert NotMinter();
        _;
    }

    // ------------------------------------------------------------------ roles

    /// Grant or revoke MINTER: a team key, a PackShop, a fixed-price minter.
    function setMinter(address who, bool on) external onlyAdmin {
        if (who == address(0)) revert ZeroAddress();
        minters[who] = on;
        emit MinterSet(who, on);
    }

    function transferAdmin(address to) external onlyAdmin {
        if (to == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, to);
        admin = to;
    }

    // ------------------------------------------------------------------ mint (the IStudioMinter ABI)

    function mintStudio(StudioCard calldata c) external onlyMinter returns (uint256) {
        return _mintOne(c);
    }

    function mintBatch(StudioCard[] calldata cs) external onlyMinter returns (uint256[] memory ids) {
        if (cs.length == 0) revert EmptyBatch();
        ids = new uint256[](cs.length);
        for (uint256 i = 0; i < cs.length; i++) ids[i] = _mintOne(cs[i]);
    }

    /// The stat band every stat of a Kind must sit in; (0, 0) for a Kind this collection does not have.
    function bandOf(uint8 kind) external view returns (uint16, uint16) {
        if (kind >= _rules.kinds) return (0, 0);
        return (_min[kind], _max[kind]);
    }

    function _mintOne(StudioCard calldata c) internal returns (uint256 tokenId) {
        _checkCard(c);
        if (maxSupply != 0 && nextIndex >= maxSupply) revert SoldOut();
        uint32 index = nextIndex++;
        tokenId = (uint256(setId) << 32) | index;
        Traits calldata t = c.traits;
        _champions[tokenId] = Champion(index, c.kind, t.faction, t.alignment, t.element, t.frame, t.bodyparts, false, msg.sender);
        _stats[tokenId] = CoreStats(t.strength, t.agility, t.resilience, t.intelligence, 1, 0);
        _designs[tokenId] = c.design;
        if (c.styleSource.collection != address(0)) _origin[tokenId] = c.styleSource;
        // a champion minted with its SOUL.MD starts with that soul committed, in its manifest and its registry twin
        if (c.design.soul != bytes32(0)) _soul[tokenId] = c.design.soul;
        totalSupply += 1;
        _mint(c.to, tokenId);
        emit ChampionMinted(tokenId, c.to, msg.sender, c.design.designHash);
        if (registry.minters(address(this))) {
            _mirror(tokenId);
        } else {
            pendingMirrors += 1;
            emit MirrorPending(tokenId);
        }
    }

    /// The checks every card passes before it is minted. A collection with rules of its own (Rapture ARC 1 also
    /// ties body parts to Kinds) overrides this and calls super._checkCard(c) first.
    function _checkCard(StudioCard calldata c) internal view virtual {
        Rules storage r = _rules;
        Traits calldata t = c.traits;
        if (c.to == address(0)) revert ZeroAddress();
        if (c.kind >= r.kinds) revert BadKind();
        if (t.faction > r.maxFaction || t.element > r.maxElement || t.frame > r.maxFrame) revert BadTraits();
        if (t.alignment > r.maxAlignment && !(r.sealedAlignment && t.alignment == SEALED)) revert BadTraits();
        for (uint256 i = 0; i < 4; i++) {
            if (((t.bodyparts >> (8 * i)) & 0xff) > r.maxParts[i]) revert BadParts();
        }
        uint16 lo = _min[c.kind];
        uint16 hi = _max[c.kind];
        if (t.strength < lo || t.strength > hi || t.agility < lo || t.agility > hi) revert OutOfBand();
        if (t.resilience < lo || t.resilience > hi || t.intelligence < lo || t.intelligence > hi) revert OutOfBand();
        bool needsKit = (r.kitKinds >> c.kind) & 1 == 1;
        if (needsKit ? (c.design.kit == 0 || c.design.kit > r.maxKit) : c.design.kit != 0) revert BadKit();
        _checkDesign(c.design, r.requireAvatar);
    }

    /// Hashes, not locations: the art host can move without anything on chain changing. Names go into on-chain JSON
    /// unescaped, so their charset is closed (letters, digits, space and ' , - . : _), as Rapture's CardDesign.
    function _checkDesign(Design calldata d, bool requireAvatar) internal pure {
        if (d.designHash == bytes32(0) || d.art == bytes32(0)) revert BadDesign();
        if (d.avatarPlain != bytes32(0) && d.avatar == bytes32(0)) revert BadDesign();
        if (requireAvatar && (d.avatar == bytes32(0) || d.avatarPlain == bytes32(0))) revert BadDesign();
        _checkName(d.name, 1, 40);
        _checkName(d.epithet, 0, 48);
    }

    // ------------------------------------------------------------------ the registry mirror

    /// The token's id in the registry. Hashing in this contract's address keeps it clear of every other
    /// collection's ids; LitNode clients queue a champion by this id.
    function registryIdOf(uint256 tokenId) public view returns (uint256) {
        return uint256(keccak256(abi.encode(address(this), tokenId)));
    }

    /// Mirror tokens minted before the registry admin approved this collection. Anyone may call.
    function mirror(uint256[] calldata tokenIds) external {
        if (!registry.minters(address(this))) revert NotApproved();
        for (uint256 i = 0; i < tokenIds.length; i++) {
            _requireOwned(tokenIds[i]);
            if (_champions[tokenIds[i]].mirrored) revert AlreadyMirrored(tokenIds[i]);
            pendingMirrors -= 1;
            _mirror(tokenIds[i]);
        }
    }

    /// Forge the twin: same stats, this contract as owner, the holder as controller, the image-free
    /// character.json hash and the soul.
    function _mirror(uint256 tokenId) internal {
        _champions[tokenId].mirrored = true;
        (string memory uri, bytes32 hash) = metadata.agentConfig(tokenId);
        uint256 regId = registryIdOf(tokenId);
        registry.forge(regId, address(this), _stats[tokenId], AgentManifest(uri, _soul[tokenId], _controller[tokenId], hash, 0, 0));
        emit Mirrored(tokenId, regId);
    }

    function isMirrored(uint256 tokenId) external view returns (bool) {
        return _champions[tokenId].mirrored;
    }

    // ------------------------------------------------------------------ transfers

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        if (_ownerOf(tokenId) != address(0) && to != address(0)) _clearSlots(tokenId);
        from = super._update(to, tokenId, auth);
        if (to != address(0)) {
            address ctl = _defaultController(to);
            _controller[tokenId] = ctl;
            emit ControllerSet(tokenId, ctl);
            if (_champions[tokenId].mirrored) registry.setController(registryIdOf(tokenId), ctl);
        } else {
            delete _controller[tokenId];
        }
    }

    /// A linked signer's champions are played by its proxy (when an identity link is set), so a node can queue and
    /// equip for the player without holding the asset. Otherwise the holder controls its own.
    function _defaultController(address owner) internal view returns (address) {
        if (address(identity) == address(0)) return owner;
        uint256 p = identity.profileOfSigner(owner);
        return p != 0 ? identity.proxyOf(p) : owner;
    }

    // ------------------------------------------------------------------ ERC-6699

    function coreStats(uint256 tokenId) external view returns (CoreStats memory) {
        return _stats[tokenId];
    }

    function manifestOf(uint256 tokenId) external view returns (AgentManifest memory m) {
        _requireOwned(tokenId);
        (string memory uri, bytes32 hash) = metadata.agentConfig(tokenId);
        m = AgentManifest(uri, _soul[tokenId], _controller[tokenId], hash, 0, _manifestNonce[tokenId]);
    }

    function equipped(uint256 tokenId, bytes32 slot) external view returns (address, uint256) {
        return (_slotCollection[tokenId][slot], _slotAsset[tokenId][slot]);
    }

    /// The champion's OWNER must own the item on its collection (the LitNode registry v2 rule).
    function equip(uint256 tokenId, bytes32 slot, address collection, uint256 assetId) external {
        address owner = _onlyOwnerOrController(tokenId);
        (bool ok, bytes memory ret) = collection.staticcall(abi.encodeWithSignature("ownerOf(uint256)", assetId));
        if (!ok || ret.length < 32 || abi.decode(ret, (address)) != owner) revert ItemNotOwned();
        if (_slotCollection[tokenId][slot] == address(0)) {
            if (_slots[tokenId].length >= MAX_SLOTS) revert TooManySlots();
            _slots[tokenId].push(slot);
        }
        _slotCollection[tokenId][slot] = collection;
        _slotAsset[tokenId][slot] = assetId;
        emit Equipped(tokenId, slot, collection, assetId);
    }

    function unequip(uint256 tokenId, bytes32 slot) external {
        _onlyOwnerOrController(tokenId);
        delete _slotCollection[tokenId][slot];
        delete _slotAsset[tokenId][slot];
        emit Equipped(tokenId, slot, address(0), 0);
    }

    function _clearSlots(uint256 tokenId) internal {
        bytes32[] storage s = _slots[tokenId];
        for (uint256 i = 0; i < s.length; i++) {
            delete _slotCollection[tokenId][s[i]];
            delete _slotAsset[tokenId][s[i]];
            emit Equipped(tokenId, s[i], address(0), 0);
        }
        delete _slots[tokenId];
    }

    /// keccak256(SOUL.MD), committed by the owner or controller; the registry twin follows.
    function setSoul(uint256 tokenId, bytes32 soulManifestHash) external {
        _onlyOwnerOrController(tokenId);
        _soul[tokenId] = soulManifestHash;
        _manifestNonce[tokenId] += 1;
        emit ManifestUpdated(tokenId, soulManifestHash);
        if (_champions[tokenId].mirrored) {
            (string memory uri, bytes32 hash) = metadata.agentConfig(tokenId);
            registry.setManifest(registryIdOf(tokenId), uri, soulManifestHash, hash);
        }
    }

    function setController(uint256 tokenId, address controller) external {
        if (msg.sender != _requireOwned(tokenId)) revert NotOwner();
        _controller[tokenId] = controller;
        emit ControllerSet(tokenId, controller);
        if (_champions[tokenId].mirrored) registry.setController(registryIdOf(tokenId), controller);
    }

    function _onlyOwnerOrController(uint256 tokenId) internal view returns (address owner) {
        owner = _requireOwned(tokenId);
        if (msg.sender != owner && msg.sender != _controller[tokenId]) revert NotController();
    }

    // ------------------------------------------------------------------ reads

    function championOf(uint256 tokenId) external view returns (Champion memory) {
        return _champions[tokenId];
    }

    function designOf(uint256 tokenId) external view returns (Design memory) {
        return _designs[tokenId];
    }

    function originOf(uint256 tokenId) external view returns (Origin memory) {
        return _origin[tokenId];
    }

    function rules() external view returns (Rules memory) {
        return _rules;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return metadata.tokenURI(tokenId);
    }

    function contractURI() external view returns (string memory) {
        return metadata.contractURI();
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC6699).interfaceId || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ text checks

    /// Letters, digits, space and ' , - . : _ (CardDesign's charset): safe unescaped in JSON, HTML and SVG.
    function _checkName(string calldata s, uint256 minLen, uint256 maxLen) internal pure {
        bytes calldata b = bytes(s);
        if (b.length < minLen || b.length > maxLen) revert BadName();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
                || c == 0x20 || c == 0x27 || c == 0x2c || c == 0x2d || c == 0x2e || c == 0x3a || c == 0x5f;
            if (!ok) revert BadName();
        }
    }

    /// Printable ASCII without '"' and '\': safe unescaped inside a JSON string.
    function _checkJson(string memory s, uint256 minLen, uint256 maxLen) internal pure {
        bytes memory b = bytes(s);
        if (b.length < minLen || b.length > maxLen) revert BadName();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7e || c == 0x22 || c == 0x5c) revert BadName();
        }
    }
}
