// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FeeController} from "../src/FeeController.sol";
import {TokenFactory} from "../src/TokenFactory.sol";

/// TokenFactory's name rule: 1-64 bytes of well-formed UTF-8, no leading or trailing space, and no control,
/// bidirectional, line-breaking or invisible character. The explicit cases are in test/vectors/names.json, which the
/// Mint form's tests read too, so the contract and the form are held to the same list.
/// Zero-width and other invisible characters are written as \u escapes: this file carries none literally.
contract TokenFactoryNamesTest is Test {
    /// One entry of test/vectors/names.json: the exact bytes of a name, and whether TokenFactory must accept it.
    struct NameVector {
        bytes name;
        string note;
        bool valid;
    }

    FeeController internal fees;
    TokenFactory internal factory;
    address internal creator = makeAddr("creator");
    uint256 internal constant FEE = 15 ether;

    function setUp() public {
        fees = new FeeController(address(this), payable(makeAddr("recipient")));
        fees.addKey(keccak256("MINT_FLAT"), FEE, 50 ether);
        factory = new TokenFactory(fees);
    }

    function _params(bytes memory name, bool mintable, bool burnable)
        internal
        view
        returns (TokenFactory.TokenParams memory)
    {
        return TokenFactory.TokenParams({
            name: string(name),
            symbol: "NAME",
            decimals: 18,
            initialSupply: 1_000 ether,
            mintable: mintable,
            burnable: burnable,
            cap: 0,
            holder: creator
        });
    }

    /// The motivating case: stored as U+202E followed by "CDSU", a name renders as "USDC". Every token kind refuses it,
    /// because every kind goes through the same check.
    function test_name_rejectsARightToLeftOverride_forEveryTokenKind() public {
        bytes memory spoof = bytes(unicode"\u202eCDSU"); // U+202E RIGHT-TO-LEFT OVERRIDE, then "CDSU"
        assertEq(spoof, hex"e280ae43445355");
        for (uint256 kind; kind < 4; ++kind) {
            vm.deal(creator, FEE);
            vm.prank(creator);
            vm.expectRevert(TokenFactory.BadName.selector);
            factory.createToken{value: FEE}(_params(spoof, (kind & 1) == 1, (kind & 2) == 2));
        }
    }

    /// Turkish letters, emoji, ZWJ sequences and variation selectors are allowed on purpose, for every token kind, and
    /// the name is stored exactly as sent.
    function test_name_acceptsTurkishLettersAndEmoji_forEveryTokenKind() public {
        bytes memory dev = bytes(unicode"👨\u200d💻 Dev"); // U+1F468 ZWJ U+1F4BB
        assertEq(dev, hex"f09f91a8e2808df09f92bb20446576");
        bytes memory love = bytes(unicode"❤\ufe0f Love"); // U+2764 and variation selector 16
        assertEq(love, hex"e29da4efb88f204c6f7665");
        bytes[4] memory names = [bytes(unicode"Köpek"), bytes(unicode"Şeker"), dev, love];
        for (uint256 kind; kind < 4; ++kind) {
            vm.deal(creator, FEE);
            vm.prank(creator);
            address token = factory.createToken{value: FEE}(_params(names[kind], (kind & 1) == 1, (kind & 2) == 2));
            assertEq(bytes(IERC20Metadata(token).name()), names[kind]);
        }
    }

    /// Every vector in test/vectors/names.json, through createToken and through the reference below. A disagreement
    /// is logged with its note, so a failing run lists all of them rather than the first.
    function test_name_matchesTheSharedVectors() public {
        string memory json = vm.readFile("test/vectors/names.json");
        // parseJsonTypeArray, not parseJson: parseJson would read a 20-byte name as an address and a 32-byte one as a
        // bytes32, and the array would no longer decode as bytes.
        NameVector[] memory vectors = abi.decode(
            vm.parseJsonTypeArray(json, ".names", "NameVector(bytes name,string note,bool valid)"), (NameVector[])
        );
        uint256 accepted;
        uint256 disagreements;
        for (uint256 i; i < vectors.length; ++i) {
            NameVector memory v = vectors[i];
            if (v.valid) ++accepted;
            if (_isValidName(v.name) != v.valid) {
                console.log("the reference disagrees:", v.note);
                ++disagreements;
            }
            if (_accepts(v.name) != v.valid) {
                console.log(v.valid ? "TokenFactory rejects:" : "TokenFactory accepts:", v.note);
                ++disagreements;
            }
        }
        assertEq(disagreements, 0, "disagreements with names.json");
        assertGt(accepted, 0, "names.json has names to accept");
        assertGt(vectors.length - accepted, 0, "names.json has names to reject");
    }

    /// Differential fuzz on raw bytes (1-64 of them): mostly noise, so mostly rejected, and never for another reason.
    function testFuzz_name_agreesWithTheReference_onRawBytes(bytes32 w0, bytes32 w1, uint256 length) public {
        length = bound(length, 1, 64);
        bytes memory words = abi.encodePacked(w0, w1);
        bytes memory name = new bytes(length);
        for (uint256 i; i < length; ++i) {
            name[i] = words[i];
        }
        _assertAgrees(name);
    }

    /// Differential fuzz on names of 1-16 encoded code points: mostly well-formed multi-byte input, much of it next to
    /// a banned code point or a range boundary.
    function testFuzz_name_agreesWithTheReference_onCodePoints(uint32[16] memory seeds, uint256 count) public {
        _assertAgrees(_encode(seeds, bound(count, 1, 16)));
    }

    /// Differential fuzz on the same names with one byte overwritten or the end cut off: near-misses of well-formed
    /// input, where a byte walk that skips a check or loses its place goes wrong.
    function testFuzz_name_agreesWithTheReference_onDamagedCodePoints(
        uint32[16] memory seeds,
        uint256 count,
        uint256 at,
        bytes1 value,
        bool cut
    ) public {
        bytes memory name = _encode(seeds, bound(count, 1, 16));
        at = bound(at, 0, name.length - 1);
        if (cut) {
            bytes memory head = new bytes(at + 1);
            for (uint256 i; i <= at; ++i) {
                head[i] = name[i];
            }
            name = head;
        } else {
            name[at] = value;
        }
        _assertAgrees(name);
    }

    function test_utf8Encoder_matchesTheTable() public pure {
        assertEq(_utf8(0x7F), hex"7f");
        assertEq(_utf8(0x80), hex"c280");
        assertEq(_utf8(0x7FF), hex"dfbf");
        assertEq(_utf8(0x800), hex"e0a080");
        assertEq(_utf8(0x20AC), hex"e282ac");
        assertEq(_utf8(0xFFFF), hex"efbfbf");
        assertEq(_utf8(0x10000), hex"f0908080");
        assertEq(_utf8(0x10FFFF), hex"f48fbfbf");
        assertEq(_utf8(0xD800), hex"eda080"); // not a character, but the fuzzer needs near-misses
        assertEq(_utf8(0x110000), hex"f4908080");
    }

    /// Creates a token named `name` and says whether TokenFactory accepted it. The only revert allowed is BadName, and
    /// an accepted name is stored byte for byte.
    function _accepts(bytes memory name) internal returns (bool) {
        vm.deal(creator, FEE);
        vm.prank(creator);
        try factory.createToken{value: FEE}(_params(name, false, false)) returns (address token) {
            assertEq(bytes(IERC20Metadata(token).name()), name, "the name is stored as sent");
            return true;
        } catch (bytes memory reason) {
            assertEq(reason, abi.encodeWithSelector(TokenFactory.BadName.selector), "the only revert is BadName");
            return false;
        }
    }

    function _assertAgrees(bytes memory name) internal {
        assertEq(_accepts(name), _isValidName(name), "TokenFactory and the reference disagree");
    }

    /// Reference for TokenFactory's name check, written differently on purpose: it decodes each code point from the
    /// bit patterns alone and only then checks the value (shortest form, surrogates, U+10FFFF, the banned list), where
    /// TokenFactory walks Unicode Table 3-7 byte by byte.
    function _isValidName(bytes memory b) internal pure returns (bool) {
        if (b.length == 0 || b.length > 64 || b[0] == " " || b[b.length - 1] == " ") return false;
        uint256 i;
        while (i < b.length) {
            uint256 lead = uint8(b[i]);
            uint256 size;
            uint256 cp;
            uint256 shortest;
            if (lead >> 7 == 0) {
                (size, cp, shortest) = (1, lead, 0);
            } else if (lead >> 5 == 0x06) {
                (size, cp, shortest) = (2, lead & 0x1F, 0x80);
            } else if (lead >> 4 == 0x0E) {
                (size, cp, shortest) = (3, lead & 0x0F, 0x800);
            } else if (lead >> 3 == 0x1E) {
                (size, cp, shortest) = (4, lead & 0x07, 0x10000);
            } else {
                return false; // 10xxxxxx or 11111xxx
            }
            if (i + size > b.length) return false;
            for (uint256 k = 1; k < size; ++k) {
                uint256 next = uint8(b[i + k]);
                if (next >> 6 != 0x02) return false;
                cp = (cp << 6) | (next & 0x3F);
            }
            if (cp < shortest || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) || _isBanned(cp)) return false;
            i += size;
        }
        return true;
    }

    /// The C0 and C1 controls and DEL as ranges, the other seventeen one by one (TokenFactory compares ranges).
    function _isBanned(uint256 cp) internal pure returns (bool) {
        if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F)) return true;
        uint24[17] memory listed = [
            uint24(0x061C),
            0x200E,
            0x200F,
            0x2028,
            0x2029,
            0x202A,
            0x202B,
            0x202C,
            0x202D,
            0x202E,
            0x2066,
            0x2067,
            0x2068,
            0x2069,
            0x200B,
            0x2060,
            0xFEFF
        ];
        for (uint256 k; k < listed.length; ++k) {
            if (cp == listed[k]) return true;
        }
        return false;
    }

    function _encode(uint32[16] memory seeds, uint256 count) internal pure returns (bytes memory name) {
        for (uint256 i; i < count; ++i) {
            name = bytes.concat(name, _utf8(_codePoint(seeds[i])));
        }
    }

    /// Spreads fuzzed words over every UTF-8 length, with extra weight next to banned code points and range edges.
    /// Surrogates and values above U+10FFFF come out too, and `_utf8` encodes them, so near-misses are fed as well.
    function _codePoint(uint32 seed) internal pure returns (uint256) {
        // A seed this small is used as it is: the fuzzer's dictionary holds the constants found in TokenFactory's
        // bytecode and in this test's (0x202E, ...).
        if (seed < 0x110010) return seed;
        uint256 kind = seed % 16;
        uint256 x = seed / 16;
        if (kind < 4) return 0x20 + x % 0x5F; // printable ASCII, space included
        if (kind < 6) return 0x80 + x % 0x780; // any 2-byte code point
        if (kind < 8) return 0x800 + x % 0xF800; // any 3-byte one, surrogates included
        if (kind < 10) return 0x10000 + x % 0x100000; // any 4-byte one
        if (kind == 10) return x % 0xA1; // U+0000-U+00A0: C0, DEL, C1 and their neighbours
        if (kind == 11) return 0x600 + x % 0x40; // around U+061C
        if (kind == 12) return 0x2000 + x % 0x80; // U+2000-U+207F: separators, other bidi controls, invisible spaces
        if (kind == 13) return 0xFE00 + x % 0x200; // variation selectors, U+FEFF, and up to U+FFFF
        if (kind == 14) return 0xD7F0 + x % 0x820; // the surrogates and both of their edges
        return 0x10FFF0 + x % 0x20; // the last code points and the first values past U+10FFFF
    }

    /// Lenient UTF-8 encoder: also encodes surrogates and values up to U+1FFFFF, which no well-formed name contains.
    function _utf8(uint256 cp) internal pure returns (bytes memory) {
        // casting to 'uint8' is safe because cp < 0x80
        // forge-lint: disable-next-line(unsafe-typecast)
        if (cp < 0x80) return abi.encodePacked(uint8(cp));
        if (cp < 0x800) return abi.encodePacked(uint8(0xC0 | (cp >> 6)), uint8(0x80 | (cp & 0x3F)));
        if (cp < 0x10000) {
            return
                abi.encodePacked(uint8(0xE0 | (cp >> 12)), uint8(0x80 | ((cp >> 6) & 0x3F)), uint8(0x80 | (cp & 0x3F)));
        }
        return abi.encodePacked(
            uint8(0xF0 | (cp >> 18)),
            uint8(0x80 | ((cp >> 12) & 0x3F)),
            uint8(0x80 | ((cp >> 6) & 0x3F)),
            uint8(0x80 | (cp & 0x3F))
        );
    }
}
