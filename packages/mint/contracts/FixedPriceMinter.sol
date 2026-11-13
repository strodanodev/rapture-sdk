// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Traits, Origin, Design} from "./vendor/rapture/interfaces/Rapture.sol";
import {StudioCard, IStudioMinter} from "./interfaces/IStudioMinter.sol";

/// @title FixedPriceMinter: the default minter of the Rapture SDK mint package.
///
/// A catalogue of card TEMPLATES (a card's kind, traits, stats and design record), each with a capped edition size.
/// A buyer picks a template, pays `price` per card, and the cards are minted straight to their wallet in the same
/// transaction, as new tokens of the collection (editions: a hundred wallets can hold a copy of one design, each its
/// own token). Nothing is random, so nothing can be previewed or grinded, and there is nothing to refund: a mint
/// either happens or reverts with the buyer's money.
///
/// It mints through the collection's minter (IStudioMinter: Rapture's StudioMinter, or a collection made with
/// the Rapture SDK collection package), whose admin grants this contract the MINTER role with setMinter(minter, true).
///
/// The owner loads templates while unlocked. lock() freezes the catalogue and every edition size for good. Then the
/// owner can only set the price and the per-wallet limit, pause and unpause sales, mint within the caps
/// (ownerMint: airdrops, the team's copies), and withdraw revenue. Deploys PAUSED: stock it, then unpause().
contract FixedPriceMinter is Ownable2Step, Pausable, ReentrancyGuard {
    /// A card the minter can mint: StudioCard minus the recipient.
    struct Template {
        uint8 kind;
        Traits traits;
        Origin styleSource;
        Design design;
    }

    struct Edition {
        uint32 maxSupply;
        uint32 minted;
        bool retired;
    }

    /// Cards per transaction: about 0.9M gas each on the reference collection, so a full batch stays under 10M.
    uint256 public constant MAX_PER_TX = 10;
    uint256 public constant MAX_TEMPLATES = 4096;
    /// Most editions one editionsOf() call returns.
    uint256 public constant PAGE = 256;

    IStudioMinter public immutable minter;

    /// Exact price of one card, in wei of the native token (zkLTC on LitVM).
    uint256 public price;
    /// Cards one wallet may buy through mint(), ever; 0 = no limit. ownerMint() does not count.
    uint32 public maxPerWallet;
    /// The catalogue is frozen: no template can be added or retired, and no edition size can change.
    bool public locked;
    /// Cards minted through this contract, by mint() and ownerMint().
    uint256 public totalMinted;

    Template[] internal _templates;
    Edition[] internal _editions;
    mapping(bytes32 => bool) public hasDesign;
    mapping(address => uint256) public mintedBy;
    /// tokenId -> templateId + 1 (0 = not minted here).
    mapping(uint256 => uint256) private _templatePlusOne;

    event Minted(address indexed payer, address indexed to, uint256 indexed templateId, uint256[] tokenIds, uint256 paid);
    event TemplateAdded(uint256 indexed templateId, uint8 indexed kind, bytes32 designHash, uint32 maxSupply);
    event TemplateRetired(uint256 indexed templateId);
    event Locked(uint256 templates);
    event PriceSet(uint256 price);
    event MaxPerWalletSet(uint32 limit);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error BadMinter();
    error NotMinter();
    error BadQuantity();
    error WrongPayment();
    error SoldOut();
    error WalletLimitReached();
    error UnknownTemplate();
    error BadTemplate();
    error DuplicateDesign();
    error TooManyTemplates();
    error IsLocked();
    error Insufficient();
    error TransferFailed();
    error RenounceDisabled();

    constructor(IStudioMinter minter_, address owner_, uint256 price_, uint32 maxPerWallet_) Ownable(owner_) {
        if (address(minter_) == address(0)) revert ZeroAddress();
        if (address(minter_).code.length == 0) revert BadMinter();
        minter = minter_;
        price = price_;
        maxPerWallet = maxPerWallet_;
        _pause();
    }

    // ------------------------------------------------------------------ buy

    /// Pay exactly price * quantity and receive `quantity` new cards of `templateId`.
    function mint(uint256 templateId, uint256 quantity) external payable whenNotPaused nonReentrant returns (uint256[] memory tokenIds) {
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
        if (msg.value != price * quantity) revert WrongPayment();
        uint256 limit = maxPerWallet;
        if (limit != 0 && mintedBy[msg.sender] + quantity > limit) revert WalletLimitReached();
        mintedBy[msg.sender] += quantity;
        tokenIds = _mintTo(msg.sender, templateId, quantity);
        emit Minted(msg.sender, msg.sender, templateId, tokenIds, msg.value);
    }

    /// The owner mints within the edition caps, for free and while paused: airdrops, prizes, the team's copies.
    function ownerMint(address to, uint256 templateId, uint256 quantity) external onlyOwner nonReentrant returns (uint256[] memory tokenIds) {
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
        tokenIds = _mintTo(to, templateId, quantity);
        emit Minted(msg.sender, to, templateId, tokenIds, 0);
    }

    function _mintTo(address to, uint256 templateId, uint256 quantity) internal returns (uint256[] memory tokenIds) {
        if (to == address(0)) revert ZeroAddress();
        if (templateId >= _templates.length) revert UnknownTemplate();
        Edition storage e = _editions[templateId];
        if (e.retired) revert UnknownTemplate();
        if (uint256(e.minted) + quantity > e.maxSupply) revert SoldOut();
        if (!minter.minters(address(this))) revert NotMinter();
        e.minted += uint32(quantity);
        totalMinted += quantity;

        Template storage t = _templates[templateId];
        StudioCard[] memory cs = new StudioCard[](quantity);
        for (uint256 i = 0; i < quantity; i++) cs[i] = StudioCard(to, t.kind, t.traits, t.styleSource, t.design);
        tokenIds = minter.mintBatch(cs);
        if (tokenIds.length != quantity) revert BadMinter();
        for (uint256 i = 0; i < quantity; i++) _templatePlusOne[tokenIds[i]] = templateId + 1;
    }

    // ------------------------------------------------------------------ views

    /// Can a card be bought right now (ignoring pause, editions and the caller's limit)? The MINTER role is the test.
    function ready() public view returns (bool) {
        return minter.minters(address(this));
    }

    /// One call for a client: everything it needs to draw the mint button and the supply counter.
    function config()
        external
        view
        returns (
            uint256 price_,
            uint32 maxPerWallet_,
            bool paused_,
            bool ready_,
            bool locked_,
            uint256 templateCount_,
            uint256 totalMinted_,
            uint256 maxSupply_
        )
    {
        uint256 cap;
        for (uint256 i = 0; i < _editions.length; i++) if (!_editions[i].retired) cap += _editions[i].maxSupply;
        return (price, maxPerWallet, paused(), ready(), locked, _templates.length, totalMinted, cap);
    }

    function templateCount() external view returns (uint256) {
        return _templates.length;
    }

    function templateOf(uint256 templateId) external view returns (Template memory) {
        if (templateId >= _templates.length) revert UnknownTemplate();
        return _templates[templateId];
    }

    function editionOf(uint256 templateId) external view returns (Edition memory) {
        if (templateId >= _templates.length) revert UnknownTemplate();
        return _editions[templateId];
    }

    /// Editions `from` .. `from + n - 1` (at most PAGE, clipped to the catalogue): the catalogue page in one call.
    function editionsOf(uint256 from, uint256 n)
        external
        view
        returns (uint32[] memory maxSupply, uint32[] memory minted, bool[] memory retired)
    {
        uint256 len = _editions.length;
        if (from > len) from = len;
        if (n > PAGE) n = PAGE;
        if (n > len - from) n = len - from;
        maxSupply = new uint32[](n);
        minted = new uint32[](n);
        retired = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            Edition storage e = _editions[from + i];
            (maxSupply[i], minted[i], retired[i]) = (e.maxSupply, e.minted, e.retired);
        }
    }

    /// The template each token was minted from, as templateId + 1; 0 for a token this contract did not mint.
    function templatesOf(uint256[] calldata tokenIds) external view returns (uint256[] memory plusOne) {
        plusOne = new uint256[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) plusOne[i] = _templatePlusOne[tokenIds[i]];
    }

    /// Cards `who` may still buy through mint(); type(uint256).max when there is no limit.
    function mintableBy(address who) external view returns (uint256) {
        uint256 limit = maxPerWallet;
        if (limit == 0) return type(uint256).max;
        uint256 had = mintedBy[who];
        return had >= limit ? 0 : limit - had;
    }

    // ------------------------------------------------------------------ owner: catalogue (before lock())

    /// Load templates with their edition sizes (maxSupplies[i] > 0). A design can be listed once.
    function addTemplates(Template[] calldata ts, uint32[] calldata maxSupplies) external onlyOwner {
        if (locked) revert IsLocked();
        if (ts.length != maxSupplies.length) revert BadTemplate();
        if (_templates.length + ts.length > MAX_TEMPLATES) revert TooManyTemplates();
        for (uint256 i = 0; i < ts.length; i++) {
            Template calldata t = ts[i];
            if (t.design.designHash == bytes32(0) || maxSupplies[i] == 0) revert BadTemplate();
            if (hasDesign[t.design.designHash]) revert DuplicateDesign();
            hasDesign[t.design.designHash] = true;
            uint256 id = _templates.length;
            _templates.push(t);
            _editions.push(Edition(maxSupplies[i], 0, false));
            emit TemplateAdded(id, t.kind, t.design.designHash, maxSupplies[i]);
        }
    }

    /// Stop selling a template (cards already minted stay). Its id is never reused.
    function retireTemplate(uint256 templateId) external onlyOwner {
        if (locked) revert IsLocked();
        if (templateId >= _templates.length || _editions[templateId].retired) revert UnknownTemplate();
        _editions[templateId].retired = true;
        emit TemplateRetired(templateId);
    }

    /// Freeze the catalogue and every edition size, for good.
    function lock() external onlyOwner {
        if (locked) revert IsLocked();
        locked = true;
        emit Locked(_templates.length);
    }

    // ------------------------------------------------------------------ owner: settings and money

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceSet(price_);
    }

    function setMaxPerWallet(uint32 limit) external onlyOwner {
        maxPerWallet = limit;
        emit MaxPerWalletSet(limit);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// Revenue: a mint is final, so the whole balance is the owner's.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert Insufficient();
        emit Withdrawn(to, amount);
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Revenue is only reachable through the owner: renouncing would strand it.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
