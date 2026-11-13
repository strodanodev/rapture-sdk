// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Traits, Origin, Design} from "./vendor/rapture/interfaces/Rapture.sol";
import {StudioCard, IStudioMinter} from "./interfaces/IStudioMinter.sol";

/// drand evmnet randomness, verified on chain (vendor/bls-solidity/src/demos/EvmnetRegistry.sol, unmodified).
interface IEvmnetRegistry {
    /// sha256 of the round's BLS signature once someone has proven it, else 0.
    function roundRandomness(uint64 round) external view returns (bytes32);
    /// Verify `signature` for `roundNumber` against the evmnet public key and store its randomness. Reverts if invalid.
    function proveRound(bytes calldata signature, uint64 roundNumber) external;
}

/// @title PackShopV2: a capped, fixed-rarity card set sold in sealed packs, drawn from drand.
///
/// The pack option of the Rapture SDK mint package. It mints through the collection's minter (IStudioMinter: Rapture's
/// StudioMinter, or a collection made with the Rapture SDK collection package), which must grant this contract its MINTER role.
///
/// The SUPPLY is a deck fixed before sales: an exact count for every Kind x Finish cell (5 kinds x
/// Normal/Shiny/Gold). For example, "exactly 3 Gold cards of kind 4 will ever exist". Packs deal from what is left of that deck,
/// without replacement, so the final distribution is exactly the deck. Within a cell the design is drawn uniformly
/// from that Kind's templates. The deck size is the cap: total / packSize packs are sold, and the remainder
/// (total % packSize) is one reserve pack, dealt the same way to `reserveTo` after the last pack is sold.
///
/// RANDOMNESS is drand evmnet (League of Entropy, BN254, a round every 3 s), not blockhash:
///   1. buyPack()   pay the exact price. The pack is bound to drand round  now + REVEAL_DELAY,  which nobody
///                  (buyer, sequencer, owner) knows yet. "now" is the later of the chain clock's round and the latest
///                  round ever proven through this shop, so a keeper posting fresh rounds overrides a lagging clock.
///   2. openPack()  once that round is out, anyone submits its signature. EvmnetRegistry verifies it on chain, the pack
///                  is dealt from the deck, and its cards are minted to the buyer.
/// There is no refund for an unopened pack. A drand signature never expires, so a sealed pack's contents are fixed
/// from the moment its round is published, and there is nothing to skip. That closes v1's preview-and-refund
/// grinding. Packs are DEALT strictly in purchase order. With a shrinking deck, what pack N gets depends on what
/// came before it, so a free order would let someone choose the sequence and steer a Gold.
///
/// The OWNER cannot touch a pull. Templates and deck are written while unlocked, and lock() freezes them for good,
/// before the first sale. After that the owner can only pause new sales (never opening), change the price of
/// future packs, set the daily limit, withdraw revenue, and shut the shop down for good (see refund()).
///
/// Residual trust: if the chain clock lags real time by more than REVEAL_DELAY rounds (13-15 s) AND no fresh round
/// has been proven here, a buyer contract could act on a round that is already public. The lag is visible on chain,
/// unlike v1's silent blockhash steering, and the keeper answers it by proving the latest round (deal(0, ...)).
/// The collection minter's admin can still revoke this contract's MINTER role, which blocks minting. Dealt cards stay
/// recorded here (see refund()).
contract PackShopV2 is Ownable2Step, Pausable, ReentrancyGuard {
    /// A card the shop can mint: StudioCard minus the recipient.
    struct Template {
        uint8 kind;
        Traits traits;
        Origin styleSource;
        Design design;
    }

    enum PackState { None, Sealed, Dealt, Opened, Refunded }
    /// What a client shows. Waiting = the pack's drand round is not due yet. Ready = due, so fetch its signature and open.
    enum Phase { None, Waiting, Ready, Dealt, Opened, Refunded }
    /// 0 = not a card from this shop. Deck cells are indexed by finish - 1.
    enum Finish { None, Normal, Shiny, Gold }

    struct Pack {
        address buyer;
        uint64 round;      // drand evmnet round that seeds it
        PackState state;
        uint8 count;       // cards in it: packSize, or the reserve size
        uint96 paid;
        uint160 cards;     // once dealt: count x 24 bits, each templateId | finish << 16
    }

    struct Daily {
        uint32 day;
        uint16 count;
    }

    /// drand evmnet chain parameters (api.drand.sh/v2/beacons/evmnet/info). EvmnetRegistry hard-codes its public key.
    uint256 public constant DRAND_GENESIS = 1727521075;
    uint256 public constant DRAND_PERIOD = 3;
    /// Rounds between a buy's own round and the one it is bound to: 13-15 s ahead of the buy's timestamp.
    uint64 public constant REVEAL_DELAY = 5;
    /// After shutdown(), a pack still unopened this long past its round may be refunded.
    uint256 public constant REFUND_GRACE = 7 days;
    uint256 public constant KINDS = 5;
    uint256 public constant FINISHES = 3;
    uint256 public constant CELLS = 15;        // KINDS x FINISHES, 16 bits each in one word
    uint256 public constant MAX_PACK_SIZE = 6; // 6 cards x 24 bits fit Pack.cards
    uint256 public constant MAX_TEMPLATES = 4096;

    IStudioMinter public immutable minter;
    IEvmnetRegistry public immutable beacon;
    uint8 public immutable packSize;

    /// Exact price of one pack, in wei of the native token (zkLTC on LitVM). Changing it never touches sealed packs.
    uint256 public price;
    /// Packs one wallet may buy per UTC day; 0 = no limit.
    uint16 public dailyLimit;

    bool public locked;
    /// When shutdown() was called; 0 = never. One way.
    uint64 public shutdownAt;
    /// Fixed at lock(): deck total, packs for sale (total / packSize) and the reserve (total % packSize).
    uint32 public maxSupply;
    uint32 public packsTotal;
    uint32 public packsSold;
    uint8 public reserveSize;
    address public reserveTo;

    /// The highest drand round proven through this shop. buyPack never binds a round at or below it.
    uint64 public latestRound;

    uint256 public nextPackId = 1;
    /// Packs are dealt in id order; this is the next one.
    uint256 public nextToDeal = 1;
    /// Wei paid for packs not yet opened (sealed or dealt). The owner can only withdraw the balance above it.
    uint256 public liability;

    /// Deck as set and deck remaining: cell c = kind * FINISHES + (finish - 1), 16 bits at c * 16.
    uint256 internal _deckInitial;
    uint256 internal _deck;

    mapping(uint256 => Pack) private _packs;
    mapping(address => Daily) private _daily;
    mapping(address => uint256[]) private _packsOf;
    mapping(uint256 => Finish) private _finishOf;
    /// First token id minted for an opened pack. The minter's mintBatch numbers a batch consecutively.
    mapping(uint256 => uint256) private _firstTokenOf;
    Template[] internal _templates;
    uint16[][5] internal _byKind;
    mapping(bytes32 => bool) public hasDesign;
    mapping(uint256 => bool) public retired;

    event PackBought(uint256 indexed packId, address indexed buyer, uint256 paid, uint64 round);
    event ReserveQueued(uint256 indexed packId, address indexed to, uint8 count, uint64 round);
    event PackDealt(uint256 indexed packId, uint64 round, uint16[] templateIds, uint8[] finishes);
    event PackOpened(uint256 indexed packId, address indexed buyer, uint256[] tokenIds, uint16[] templateIds, uint8[] finishes);
    event PackRefunded(uint256 indexed packId, address indexed buyer, uint256 amount);
    event TemplateAdded(uint256 indexed templateId, uint8 indexed kind, bytes32 designHash);
    event TemplateRetired(uint256 indexed templateId);
    event DeckSet(uint16[3][5] counts, address reserveTo);
    event Locked(uint32 maxSupply, uint32 packsTotal, uint8 reserveSize);
    event Shutdown(uint64 at);
    event PriceSet(uint256 price);
    event DailyLimitSet(uint16 limit);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error BadPackSize();
    error BadMinter();
    error BadDeck();
    error IsLocked();
    error NotLocked();
    error IsShutdown();
    error NotMinter();
    error SoldOut();
    error WrongPayment();
    error DailyLimitReached();
    error BadPack();
    error NotDealt();
    error BeaconMissing(uint64 round);
    error BadProof();
    error NotRefundable();
    error BadTemplate();
    error DuplicateDesign();
    error UnknownTemplate();
    error TooManyTemplates();
    error Insufficient();
    error TransferFailed();
    error RenounceDisabled();

    /// Deploys PAUSED and unlocked: load the templates, set the deck, lock(), then unpause.
    constructor(IStudioMinter minter_, IEvmnetRegistry beacon_, address owner_, uint256 price_, uint8 packSize_, uint16 dailyLimit_)
        Ownable(owner_)
    {
        if (address(minter_) == address(0) || address(beacon_) == address(0)) revert ZeroAddress();
        if (address(minter_).code.length == 0 || address(beacon_).code.length == 0) revert BadMinter();
        if (packSize_ == 0 || packSize_ > MAX_PACK_SIZE) revert BadPackSize();
        if (price_ > type(uint96).max) revert WrongPayment();
        minter = minter_;
        beacon = beacon_;
        packSize = packSize_;
        price = price_;
        dailyLimit = dailyLimit_;
        _pause();
    }

    // ------------------------------------------------------------------ buy / deal / open

    function buyPack() external payable whenNotPaused nonReentrant returns (uint256 packId) {
        if (!locked) revert NotLocked();
        if (shutdownAt != 0) revert IsShutdown();
        if (packsSold >= packsTotal) revert SoldOut();
        if (!minter.minters(address(this))) revert NotMinter();   // never take money for a pack that cannot open
        if (msg.value != price) revert WrongPayment();
        _spendDaily(msg.sender);

        uint64 round = currentRound();
        if (latestRound > round) round = latestRound;   // the chain clock lags behind rounds already public
        round += REVEAL_DELAY;
        packId = _queue(msg.sender, round, packSize, msg.value);
        liability += msg.value;
        emit PackBought(packId, msg.sender, msg.value, round);

        if (++packsSold == packsTotal && reserveSize > 0) {
            uint256 rid = _queue(reserveTo, round, reserveSize, 0);
            emit ReserveQueued(rid, reserveTo, reserveSize, round);
        }
    }

    /// Deal (if needed) and mint a pack to its buyer. Anyone may call, and the cards always go to the buyer.
    /// `rounds`/`signatures` are drand evmnet beacons to prove first. Pass the pack's round, plus any earlier
    /// undealt packs' rounds that are not proven yet (pendingRounds tells which), or nothing if they already are.
    function openPack(uint256 packId, uint64[] calldata rounds, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256[] memory tokenIds)
    {
        _prove(rounds, signatures);
        Pack storage p = _packs[packId];
        if (p.state == PackState.Sealed) {
            while (nextToDeal <= packId) _dealNext(true);
        }
        if (p.state != PackState.Dealt) revert NotDealt();
        tokenIds = _mint(packId, p);
    }

    /// Keeper entry point: prove the given beacons, then deal up to `maxPacks` packs in order. Stops quietly at the
    /// first pack whose round is not proven yet. Dealing is cheap, and it fixes every pack's cards as soon as drand allows.
    function deal(uint256 maxPacks, uint64[] calldata rounds, bytes[] calldata signatures)
        external
        nonReentrant
        returns (uint256 dealt)
    {
        _prove(rounds, signatures);
        while (dealt < maxPacks && nextToDeal < nextPackId && _dealNext(false)) dealt++;
    }

    /// The escape hatch after shutdown(): the buyer may take back the price of a pack that cannot be delivered, once
    /// REFUND_GRACE has passed since both the shutdown and the pack's round. A sealed pack is refundable only while
    /// its round is unproven. Proving it (anyone, e.g. the keeper's deal()) fixes the pack instead, so a buyer who
    /// has seen a bad pull cannot hand it back. A dealt pack is refundable only once this shop can no longer mint.
    /// A refunded sealed pack is still drawn in its turn and its cards discarded, so a refund never changes anyone
    /// else's pull.
    function refund(uint256 packId) external nonReentrant {
        Pack storage p = _packs[packId];
        if (shutdownAt == 0 || msg.sender != p.buyer) revert NotRefundable();
        if (p.state == PackState.Sealed) {
            if (beacon.roundRandomness(p.round) != bytes32(0)) revert NotRefundable();
        } else if (p.state == PackState.Dealt) {
            if (minter.minters(address(this))) revert NotRefundable();
        } else {
            revert NotRefundable();
        }
        uint256 since = roundTime(p.round) > shutdownAt ? roundTime(p.round) : shutdownAt;
        if (block.timestamp < since + REFUND_GRACE) revert NotRefundable();
        p.state = PackState.Refunded;
        uint256 amount = p.paid;
        liability -= amount;
        emit PackRefunded(packId, p.buyer, amount);
        if (amount > 0) _send(p.buyer, amount);
    }

    // ------------------------------------------------------------------ draw

    function _queue(address buyer, uint64 round, uint8 count, uint256 paid) internal returns (uint256 packId) {
        packId = nextPackId++;
        _packs[packId] = Pack(buyer, round, PackState.Sealed, count, uint96(paid), 0);
        _packsOf[buyer].push(packId);
    }

    function _prove(uint64[] calldata rounds, bytes[] calldata signatures) internal {
        if (rounds.length != signatures.length) revert BadProof();
        uint64 latest = latestRound;
        for (uint256 i = 0; i < rounds.length; i++) {
            if (beacon.roundRandomness(rounds[i]) == bytes32(0)) beacon.proveRound(signatures[i], rounds[i]);
            if (rounds[i] > latest) latest = rounds[i];
        }
        latestRound = latest;
    }

    /// Deal pack `nextToDeal` and advance. If its round is not proven yet, revert (strict) or return false. A pack
    /// refunded while sealed is drawn all the same and keeps its Refunded state: its cards leave the deck unminted,
    /// exactly as if it had been dealt. Skipping it would hand every later pack a different deck, letting a refund
    /// choose other packs' pulls.
    function _dealNext(bool strict) internal returns (bool) {
        uint256 packId = nextToDeal;
        Pack storage p = _packs[packId];
        bytes32 randomness = beacon.roundRandomness(p.round);
        if (randomness == bytes32(0)) {
            if (strict) revert BeaconMissing(p.round);
            return false;
        }
        uint256 seed = uint256(keccak256(abi.encode(randomness, packId, p.buyer, address(this))));
        (uint256 deck, uint256 cards) = _draw(_deck, seed, p.count);
        _deck = deck;
        p.cards = uint160(cards);
        if (p.state == PackState.Sealed) p.state = PackState.Dealt;
        nextToDeal = packId + 1;
        (uint16[] memory ids, uint8[] memory finishes) = _unpack(cards, p.count);
        emit PackDealt(packId, p.round, ids, finishes);
        return true;
    }

    /// Deal `count` cards from `deck` without replacement. Each card picks a cell with probability (cards left in
    /// it) / (cards left in the deck), then a template uniformly within that cell's Kind.
    function _draw(uint256 deck, uint256 seed, uint256 count) internal view returns (uint256, uint256 cards) {
        uint256 left;
        for (uint256 c = 0; c < CELLS; c++) left += (deck >> (c * 16)) & 0xffff;
        for (uint256 i = 0; i < count; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 x = r % left;
            uint256 c = 0;
            while (true) {
                uint256 n = (deck >> (c * 16)) & 0xffff;
                if (x < n) break;
                x -= n;
                c++;
            }
            deck -= 1 << (c * 16);
            left--;
            uint16[] storage pool = _byKind[c / FINISHES];
            uint256 templateId = pool[(r >> 128) % pool.length];
            uint256 finish = (c % FINISHES) + 1;
            cards |= (templateId | (finish << 16)) << (i * 24);
        }
        return (deck, cards);
    }

    function _mint(uint256 packId, Pack storage p) internal returns (uint256[] memory tokenIds) {
        address buyer = p.buyer;
        p.state = PackState.Opened;
        liability -= p.paid;
        (uint16[] memory ids, uint8[] memory finishes) = _unpack(p.cards, p.count);
        StudioCard[] memory cs = new StudioCard[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            Template storage t = _templates[ids[i]];
            cs[i] = StudioCard(buyer, t.kind, t.traits, t.styleSource, t.design);
        }
        tokenIds = minter.mintBatch(cs);
        _firstTokenOf[packId] = tokenIds[0];
        for (uint256 i = 0; i < tokenIds.length; i++) _finishOf[tokenIds[i]] = Finish(finishes[i]);
        emit PackOpened(packId, buyer, tokenIds, ids, finishes);
    }

    function _unpack(uint256 cards, uint256 count) internal pure returns (uint16[] memory ids, uint8[] memory finishes) {
        ids = new uint16[](count);
        finishes = new uint8[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 card = cards >> (i * 24);
            ids[i] = uint16(card);
            finishes[i] = uint8(card >> 16);
        }
    }

    // ------------------------------------------------------------------ views

    /// The drand evmnet round published most recently by block.timestamp (round 1 is at genesis).
    function currentRound() public view virtual returns (uint64) {
        return uint64((block.timestamp - DRAND_GENESIS) / DRAND_PERIOD + 1);
    }

    /// When drand publishes `round`.
    function roundTime(uint64 round) public pure returns (uint256) {
        return DRAND_GENESIS + (uint256(round) - 1) * DRAND_PERIOD;
    }

    function phaseOf(uint256 packId) public view returns (Phase) {
        Pack storage p = _packs[packId];
        if (p.state == PackState.None) return Phase.None;
        if (p.state == PackState.Opened) return Phase.Opened;
        if (p.state == PackState.Refunded) return Phase.Refunded;
        if (p.state == PackState.Dealt) return Phase.Dealt;
        return block.timestamp < roundTime(p.round) ? Phase.Waiting : Phase.Ready;
    }

    function packOf(uint256 packId)
        external
        view
        returns (address buyer, uint64 round, Phase phase, uint256 paid, uint16[] memory templateIds, uint8[] memory finishes)
    {
        Pack storage p = _packs[packId];
        if (p.state == PackState.Dealt || p.state == PackState.Opened) (templateIds, finishes) = _unpack(p.cards, p.count);
        return (p.buyer, p.round, phaseOf(packId), p.paid, templateIds, finishes);
    }

    /// The distinct, not-yet-proven drand rounds of the packs from nextToDeal through `upTo` (at most `max`, oldest
    /// first; every one of them is undealt, refunded or not). Opening pack `upTo` needs exactly these signatures.
    function pendingRounds(uint256 upTo, uint256 max) external view returns (uint64[] memory rounds) {
        uint64[] memory buf = new uint64[](max);
        uint256 n;
        uint64 last;
        if (upTo >= nextPackId) upTo = nextPackId - 1;
        for (uint256 id = nextToDeal; id <= upTo && n < max; id++) {
            Pack storage p = _packs[id];
            if (p.round == last) continue;
            last = p.round;   // rounds never decrease with id, so equal rounds are adjacent
            if (beacon.roundRandomness(p.round) == bytes32(0)) buf[n++] = p.round;
        }
        rounds = new uint64[](n);
        for (uint256 i = 0; i < n; i++) rounds[i] = buf[i];
    }

    function packCountOf(address who) external view returns (uint256) {
        return _packsOf[who].length;
    }

    /// `who`'s most recent `n` packs (at most 16), oldest first.
    function recentPacks(address who, uint256 n)
        external
        view
        returns (uint256[] memory ids, Phase[] memory phases, uint64[] memory rounds)
    {
        uint256[] storage all = _packsOf[who];
        uint256 len = all.length;
        if (n > 16) n = 16;
        if (n > len) n = len;
        ids = new uint256[](n);
        phases = new Phase[](n);
        rounds = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 id = all[len - n + i];
            ids[i] = id;
            phases[i] = phaseOf(id);
            rounds[i] = _packs[id].round;
        }
    }

    /// The tokens an opened pack minted, in slot order (empty until it is opened), for a client whose pack someone
    /// else opened.
    function tokensOf(uint256 packId) external view returns (uint256[] memory ids) {
        Pack storage p = _packs[packId];
        if (p.state != PackState.Opened) return ids;
        ids = new uint256[](p.count);
        for (uint256 i = 0; i < ids.length; i++) ids[i] = _firstTokenOf[packId] + i;
    }

    /// Finish of a token this shop minted (Normal, Shiny or Gold), or None for any other token.
    function finishOf(uint256 tokenId) external view returns (Finish) {
        return _finishOf[tokenId];
    }

    function finishesOf(uint256[] calldata tokenIds) external view returns (Finish[] memory out) {
        out = new Finish[](tokenIds.length);
        for (uint256 i = 0; i < tokenIds.length; i++) out[i] = _finishOf[tokenIds[i]];
    }

    /// [kind][finish - 1] counts: the deck as set, and what is left of it.
    function deckInitial() external view returns (uint16[3][5] memory) {
        return _unpackDeck(_deckInitial);
    }

    function deckRemaining() external view returns (uint16[3][5] memory) {
        return _unpackDeck(_deck);
    }

    function cardsLeft() public view returns (uint256 left) {
        uint256 deck = _deck;
        for (uint256 c = 0; c < CELLS; c++) left += (deck >> (c * 16)) & 0xffff;
    }

    /// Can a pack be bought right now (ignoring pause and the caller's daily limit)?
    function ready() public view returns (bool) {
        return locked && shutdownAt == 0 && packsSold < packsTotal && minter.minters(address(this));
    }

    function packsLeftToday(address who) external view returns (uint256) {
        if (dailyLimit == 0) return type(uint256).max;
        Daily storage d = _daily[who];
        if (d.day != uint32(block.timestamp / 1 days)) return dailyLimit;
        return d.count >= dailyLimit ? 0 : dailyLimit - d.count;
    }

    /// One call for a client: everything it needs to draw the buy button and the supply counter.
    function config()
        external
        view
        returns (
            uint256 price_,
            uint8 packSize_,
            uint16 dailyLimit_,
            bool paused_,
            bool ready_,
            uint32 maxSupply_,
            uint32 packsTotal_,
            uint32 packsSold_,
            uint256 cardsLeft_,
            uint256 templateCount_
        )
    {
        return (price, packSize, dailyLimit, paused(), ready(), maxSupply, packsTotal, packsSold, cardsLeft(), _templates.length);
    }

    function templateCount() external view returns (uint256) {
        return _templates.length;
    }

    function templateOf(uint256 templateId) external view returns (Template memory) {
        if (templateId >= _templates.length) revert UnknownTemplate();
        return _templates[templateId];
    }

    function activeTemplates(uint8 kind) external view returns (uint16[] memory) {
        return _byKind[kind];
    }

    // ------------------------------------------------------------------ owner: before lock()

    /// Load cards the shop may mint. Each is checked against the rules the collection applies at mint time
    /// (_validate), so a dealt pack cannot hold a template that would revert.
    function addTemplates(Template[] calldata ts) external onlyOwner {
        if (locked) revert IsLocked();
        if (_templates.length + ts.length > MAX_TEMPLATES) revert TooManyTemplates();
        for (uint256 i = 0; i < ts.length; i++) {
            Template calldata t = ts[i];
            _validate(t);
            if (hasDesign[t.design.designHash]) revert DuplicateDesign();
            hasDesign[t.design.designHash] = true;
            uint256 id = _templates.length;
            _templates.push(t);
            _byKind[t.kind].push(uint16(id));
            emit TemplateAdded(id, t.kind, t.design.designHash);
        }
    }

    function retireTemplate(uint256 templateId) external onlyOwner {
        if (locked) revert IsLocked();
        if (templateId >= _templates.length || retired[templateId]) revert UnknownTemplate();
        retired[templateId] = true;
        hasDesign[_templates[templateId].design.designHash] = false;
        uint16[] storage pool = _byKind[_templates[templateId].kind];
        for (uint256 i = 0; i < pool.length; i++) {
            if (pool[i] == templateId) {
                pool[i] = pool[pool.length - 1];
                pool.pop();
                break;
            }
        }
        emit TemplateRetired(templateId);
    }

    /// The print run: counts[kind][finish - 1]. `to` receives the reserve pack (total % packSize cards), if any.
    function setDeck(uint16[3][5] calldata counts, address to) external onlyOwner {
        if (locked) revert IsLocked();
        uint256 deck;
        for (uint256 k = 0; k < KINDS; k++) {
            for (uint256 f = 0; f < FINISHES; f++) deck |= uint256(counts[k][f]) << ((k * FINISHES + f) * 16);
        }
        _deckInitial = deck;
        _deck = deck;
        reserveTo = to;
        emit DeckSet(counts, to);
    }

    /// Freeze the templates and the deck, for good. Every Kind with cards in the deck needs a template, the deck
    /// must fill at least one pack, and a reserve needs a recipient.
    function lock() external onlyOwner {
        if (locked) revert IsLocked();
        uint256 total;
        for (uint256 k = 0; k < KINDS; k++) {
            uint256 kindTotal;
            for (uint256 f = 0; f < FINISHES; f++) kindTotal += (_deck >> ((k * FINISHES + f) * 16)) & 0xffff;
            if (kindTotal > 0 && _byKind[k].length == 0) revert BadDeck();
            total += kindTotal;
        }
        if (total < packSize) revert BadDeck();
        uint256 reserve = total % packSize;
        if (reserve > 0 && reserveTo == address(0)) revert ZeroAddress();
        locked = true;
        maxSupply = uint32(total);
        packsTotal = uint32(total / packSize);
        reserveSize = uint8(reserve);
        emit Locked(maxSupply, packsTotal, reserveSize);
    }

    // ------------------------------------------------------------------ owner: settings and money

    function setPrice(uint256 price_) external onlyOwner {
        if (price_ > type(uint96).max) revert WrongPayment();
        price = price_;
        emit PriceSet(price_);
    }

    function setDailyLimit(uint16 limit) external onlyOwner {
        dailyLimit = limit;
        emit DailyLimitSet(limit);
    }

    /// Stops new sales. Opening is never paused: a paid pack must always be deliverable.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// End sales for good: the escape hatch if drand or minting breaks. Packs keep dealing and opening as normal (keep
    /// the keeper running), and a pack that cannot be delivered may be refunded after REFUND_GRACE (refund()).
    function shutdown() external onlyOwner {
        if (shutdownAt != 0) revert IsShutdown();
        shutdownAt = uint64(block.timestamp);
        emit Shutdown(shutdownAt);
    }

    /// Revenue only: the balance above what unopened packs could still be refunded.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance - liability) revert Insufficient();
        emit Withdrawn(to, amount);
        _send(to, amount);
    }

    /// Revenue is only reachable through the owner: renouncing would strand it.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ------------------------------------------------------------------ internals

    function _unpackDeck(uint256 deck) internal pure returns (uint16[3][5] memory out) {
        for (uint256 k = 0; k < KINDS; k++) {
            for (uint256 f = 0; f < FINISHES; f++) out[k][f] = uint16(deck >> ((k * FINISHES + f) * 16));
        }
    }

    function _spendDaily(address who) internal {
        uint16 limit = dailyLimit;
        if (limit == 0) return;
        Daily storage d = _daily[who];
        uint32 day = uint32(block.timestamp / 1 days);
        if (d.day != day) {
            d.day = day;
            d.count = 0;
        }
        if (d.count >= limit) revert DailyLimitReached();
        d.count += 1;
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// The rules the reference collection enforces at mint time: StudioMinter._check, CardDesign.write's charset and
    /// the stat band the minter reports for the kind (bandOf). A collection made with the Rapture SDK collection package keeps
    /// these rules. If yours enforces others, override this so a dealt pack can never hold a card that reverts at mint.
    function _validate(Template calldata t) internal view virtual {
        Traits calldata tr = t.traits;
        Design calldata d = t.design;
        if (t.kind > 4 || tr.faction > 1 || tr.element > 3 || tr.frame > 3) revert BadTemplate();
        if (tr.alignment > 2 && tr.alignment != 255) revert BadTemplate();
        (uint16 lo, uint16 hi) = minter.bandOf(t.kind);
        if (tr.strength < lo || tr.strength > hi || tr.agility < lo || tr.agility > hi) revert BadTemplate();
        if (tr.resilience < lo || tr.resilience > hi || tr.intelligence < lo || tr.intelligence > hi) revert BadTemplate();

        uint32 parts = tr.bodyparts;
        uint32 head = parts & 0xff;
        uint32 facet = (parts >> 8) & 0xff;
        uint32 circuit = (parts >> 16) & 0xff;
        uint32 bodyType = (parts >> 24) & 0xff;
        if (head > 3 || facet > 1 || circuit > 2 || bodyType > 1) revert BadTemplate();
        if (t.kind == 0 && facet != 0) revert BadTemplate();
        if (t.kind == 3 && (head != 0 || bodyType != 0)) revert BadTemplate();

        bool divine = t.kind == 2 || t.kind == 4;
        if (divine ? (d.kit == 0 || d.kit > 5) : d.kit != 0) revert BadTemplate();

        if (d.designHash == bytes32(0) || d.art == bytes32(0) || d.avatar == bytes32(0) || d.avatarPlain == bytes32(0)) {
            revert BadTemplate();
        }
        if (!_text(d.name, 1, 40) || !_text(d.epithet, 0, 48)) revert BadTemplate();
    }

    /// CardDesign's closed charset: letters, digits, space and  ' , - . : _
    function _text(string calldata s, uint256 minLen, uint256 maxLen) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length < minLen || b.length > maxLen) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)
                || c == 0x20 || c == 0x27 || c == 0x2c || c == 0x2d || c == 0x2e || c == 0x3a || c == 0x5f;
            if (!ok) return false;
        }
        return true;
    }
}
