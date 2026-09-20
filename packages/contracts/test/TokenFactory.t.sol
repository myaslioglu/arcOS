// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IFeeController} from "../src/interfaces/IFeeController.sol";
import {FeeController} from "../src/FeeController.sol";
import {TokenFactory} from "../src/TokenFactory.sol";
import {MintableToken} from "../src/tokens/MintableToken.sol";
import {BurnableToken} from "../src/tokens/BurnableToken.sol";
import {MintableBurnableToken} from "../src/tokens/MintableBurnableToken.sol";

/// A fee recipient whose receive() reverts, like a smart-contract wallet with a broken fallback.
contract RevertingReceiver {
    receive() external payable {
        revert("nope");
    }
}

contract TokenFactoryTest is Test {
    FeeController internal fees;
    TokenFactory internal factory;
    address payable internal recipient = payable(makeAddr("recipient"));
    address internal creator = makeAddr("creator");
    uint256 internal constant FEE = 15 ether;

    event TokenCreated(
        address indexed creator,
        address indexed token,
        address indexed holder,
        string name,
        string symbol,
        uint8 decimals,
        uint256 initialSupply,
        uint256 cap,
        bool mintable,
        bool burnable
    );

    function setUp() public {
        fees = new FeeController(address(this), recipient);
        fees.addKey(keccak256("MINT_FLAT"), FEE, 50 ether);
        factory = new TokenFactory(fees);
        vm.deal(creator, 100 ether);
    }

    function _params(bool mintable, bool burnable, uint256 cap)
        internal
        view
        returns (TokenFactory.TokenParams memory)
    {
        return _params(mintable, burnable, cap, 18);
    }

    function _params(bool mintable, bool burnable, uint256 cap, uint8 decimals_)
        internal
        view
        returns (TokenFactory.TokenParams memory)
    {
        return TokenFactory.TokenParams({
            name: "Duke",
            symbol: "DUKE",
            decimals: decimals_,
            initialSupply: 1_000_000 ether,
            mintable: mintable,
            burnable: burnable,
            cap: cap,
            holder: creator
        });
    }

    function _repeat(bytes1 ch, uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = ch;
        }
        return string(b);
    }

    function test_standard_mintsSupplyToHolder_forwardsFee_holdsNothing() public {
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(_params(false, false, 0));
        assertEq(IERC20Metadata(token).balanceOf(creator), 1_000_000 ether);
        assertEq(IERC20Metadata(token).decimals(), 18);
        assertEq(IERC20Metadata(token).symbol(), "DUKE");
        assertEq(recipient.balance, FEE);
        assertEq(address(factory).balance, 0);
    }

    function test_standard_hasNoOwnerAndNoMint() public {
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(_params(false, false, 0));
        (bool hasOwner,) = token.staticcall(abi.encodeWithSignature("owner()"));
        (bool canMint,) = token.call(abi.encodeWithSignature("mint(address,uint256)", creator, 1));
        assertFalse(hasOwner);
        assertFalse(canMint);
    }

    function test_registry_and_event() public {
        vm.expectEmit(true, false, true, true);
        emit TokenCreated(creator, address(0), creator, "Duke", "DUKE", 18, 1_000_000 ether, 0, false, false);
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(_params(false, false, 0));
        address[] memory mine = factory.tokensOf(creator);
        assertEq(mine.length, 1);
        assertEq(mine[0], token);
        assertTrue(factory.isArcosToken(token));
        assertFalse(factory.isArcosToken(address(this)));
    }

    function test_event_capField_isEffectiveCap() public {
        // uncapped mintable -> cap field is type(uint256).max
        vm.expectEmit(true, false, true, true);
        emit TokenCreated(
            creator, address(0), creator, "Duke", "DUKE", 18, 1_000_000 ether, type(uint256).max, true, false
        );
        vm.prank(creator);
        factory.createToken{value: FEE}(_params(true, false, 0));

        // non-mintable -> cap field is 0
        vm.expectEmit(true, false, true, true);
        emit TokenCreated(creator, address(0), creator, "Duke", "DUKE", 18, 1_000_000 ether, 0, false, true);
        vm.prank(creator);
        factory.createToken{value: FEE}(_params(false, true, 0));
    }

    function test_wrongFee_reverts() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.WrongFee.selector, FEE, FEE - 1));
        factory.createToken{value: FEE - 1}(_params(false, false, 0));
    }

    function test_mintable_ownerMintsUpToCap() public {
        vm.prank(creator);
        MintableToken token = MintableToken(factory.createToken{value: FEE}(_params(true, false, 1_500_000 ether)));
        assertEq(token.owner(), creator);
        vm.prank(creator);
        token.mint(creator, 500_000 ether);
        vm.prank(creator);
        vm.expectRevert(MintableToken.CapExceeded.selector);
        token.mint(creator, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        token.mint(address(this), 1);
    }

    function test_mintable_zeroCapMeansUncapped() public {
        vm.prank(creator);
        MintableToken token = MintableToken(factory.createToken{value: FEE}(_params(true, false, 0)));
        assertEq(token.cap(), type(uint256).max);
    }

    function test_burnable_holderBurns() public {
        vm.prank(creator);
        BurnableToken token = BurnableToken(factory.createToken{value: FEE}(_params(false, true, 0)));
        vm.prank(creator);
        token.burn(400_000 ether);
        assertEq(token.totalSupply(), 600_000 ether);
    }

    function test_mintableBurnable_deploys() public {
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(_params(true, true, 0));
        assertEq(IERC20Metadata(token).totalSupply(), 1_000_000 ether);
    }

    function test_validation() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        vm.startPrank(creator);

        p.name = "";
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);

        p = _params(false, false, 0);
        p.symbol = "THIS-SYMBOL-IS-TOO-LONG";
        vm.expectRevert(TokenFactory.BadSymbol.selector);
        factory.createToken{value: FEE}(p);

        p = _params(false, false, 0);
        p.decimals = 19;
        vm.expectRevert(TokenFactory.BadDecimals.selector);
        factory.createToken{value: FEE}(p);

        p = _params(false, false, 0);
        p.holder = address(0);
        vm.expectRevert(TokenFactory.ZeroHolder.selector);
        factory.createToken{value: FEE}(p);

        p = _params(false, false, 0);
        p.initialSupply = 0;
        vm.expectRevert(TokenFactory.ZeroSupply.selector);
        factory.createToken{value: FEE}(p);

        p = _params(true, false, 1 ether); // cap below the initial supply
        vm.expectRevert(TokenFactory.CapBelowSupply.selector);
        factory.createToken{value: FEE}(p);

        p = _params(false, false, 5 ether); // a cap on a fixed-supply token is a mistake
        vm.expectRevert(TokenFactory.CapWithoutMint.selector);
        factory.createToken{value: FEE}(p);

        vm.stopPrank();
    }

    function test_factoryFitsTheCodeSizeLimit() public view {
        assertLt(address(factory).code.length, 24_576);
    }

    // ---------------------------------------------------------------------
    // decimals
    // ---------------------------------------------------------------------

    function test_decimals_isHonoured() public {
        vm.prank(creator);
        address six = factory.createToken{value: FEE}(_params(false, false, 0, 6));
        assertEq(IERC20Metadata(six).decimals(), 6);

        vm.prank(creator);
        address zero = factory.createToken{value: FEE}(_params(false, false, 0, 0));
        assertEq(IERC20Metadata(zero).decimals(), 0);
    }

    // ---------------------------------------------------------------------
    // MintableBurnableToken gets the same behavioural coverage as MintableToken and BurnableToken
    // ---------------------------------------------------------------------

    function test_mintableBurnable_ownerMintsUpToCap_capExceeded_nonOwnerCannotMint() public {
        vm.prank(creator);
        MintableBurnableToken token =
            MintableBurnableToken(factory.createToken{value: FEE}(_params(true, true, 1_500_000 ether)));
        assertEq(token.owner(), creator);

        vm.prank(creator);
        token.mint(creator, 500_000 ether);
        assertEq(token.totalSupply(), 1_500_000 ether);

        vm.prank(creator);
        vm.expectRevert(MintableBurnableToken.CapExceeded.selector);
        token.mint(creator, 1);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
        token.mint(address(this), 1);
    }

    function test_mintableBurnable_holderBurns_thenOwnerCanMintAgainUpToCap() public {
        vm.prank(creator);
        MintableBurnableToken token =
            MintableBurnableToken(factory.createToken{value: FEE}(_params(true, true, 1_200_000 ether)));

        vm.prank(creator);
        token.burn(400_000 ether);
        assertEq(token.totalSupply(), 600_000 ether);

        // the cap bounds OUTSTANDING supply, not lifetime mints: burning frees headroom to mint again
        vm.prank(creator);
        token.mint(creator, 600_000 ether); // back up to the 1_200_000 cap
        assertEq(token.totalSupply(), 1_200_000 ether);

        vm.prank(creator);
        vm.expectRevert(MintableBurnableToken.CapExceeded.selector);
        token.mint(creator, 1);
    }

    // ---------------------------------------------------------------------
    // Minting type(uint256).max on an uncapped token must revert with CapExceeded, not a bare panic
    // ---------------------------------------------------------------------

    function test_mintable_uncappedMint_ofMaxUint_revertsCapExceeded_notPanic() public {
        vm.prank(creator);
        MintableToken token = MintableToken(factory.createToken{value: FEE}(_params(true, false, 0)));
        vm.prank(creator);
        vm.expectRevert(MintableToken.CapExceeded.selector);
        token.mint(creator, type(uint256).max);
    }

    function test_mintableBurnable_uncappedMint_ofMaxUint_revertsCapExceeded_notPanic() public {
        vm.prank(creator);
        MintableBurnableToken token = MintableBurnableToken(factory.createToken{value: FEE}(_params(true, true, 0)));
        vm.prank(creator);
        vm.expectRevert(MintableBurnableToken.CapExceeded.selector);
        token.mint(creator, type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // MintableToken and MintableBurnableToken are standalone contracts in a public repo: they can be
    // deployed directly, bypassing the factory entirely, with a starting supply above the cap they name.
    // ---------------------------------------------------------------------

    function test_mintableToken_directDeploy_supplyAboveCap_revertsCapExceeded() public {
        vm.expectRevert(MintableToken.CapExceeded.selector);
        new MintableToken("Duke", "DUKE", 18, 2_000_000 ether, 1_000_000 ether, creator);
    }

    function test_mintableBurnableToken_directDeploy_supplyAboveCap_revertsCapExceeded() public {
        vm.expectRevert(MintableBurnableToken.CapExceeded.selector);
        new MintableBurnableToken("Duke", "DUKE", 18, 2_000_000 ether, 1_000_000 ether, creator);
    }

    // ---------------------------------------------------------------------
    // A reverting fee recipient blocks createToken; fixing the recipient unblocks it
    // ---------------------------------------------------------------------

    function test_feeTransferFailed_thenWorksAfterRecipientFixed() public {
        RevertingReceiver bad = new RevertingReceiver();
        fees.setRecipient(payable(address(bad))); // this test contract is the FeeController owner

        vm.prank(creator);
        vm.expectRevert(TokenFactory.FeeTransferFailed.selector);
        factory.createToken{value: FEE}(_params(false, false, 0));

        fees.setRecipient(recipient);
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(_params(false, false, 0));
        assertTrue(token != address(0));
        assertEq(recipient.balance, FEE);
    }

    // ---------------------------------------------------------------------
    // Overpaying, name length, and per-creator registry ordering
    // ---------------------------------------------------------------------

    function test_overpayByOneWei_reverts() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.WrongFee.selector, FEE, FEE + 1));
        factory.createToken{value: FEE + 1}(_params(false, false, 0));
    }

    function test_name_64BytesPasses_65BytesReverts() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = _repeat("A", 64);
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(p);
        assertEq(IERC20Metadata(token).name(), _repeat("A", 64));

        p = _params(false, false, 0);
        p.name = _repeat("A", 65);
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_registry_twoCreators_seeOnlyOwnTokens_inCreationOrder() public {
        address creatorB = makeAddr("creatorB");
        vm.deal(creatorB, 100 ether);

        vm.prank(creator);
        address t1 = factory.createToken{value: FEE}(_params(false, false, 0));
        vm.prank(creatorB);
        address t2 = factory.createToken{value: FEE}(_params(false, false, 0));
        vm.prank(creator);
        address t3 = factory.createToken{value: FEE}(_params(false, false, 0));

        address[] memory mine = factory.tokensOf(creator);
        assertEq(mine.length, 2);
        assertEq(mine[0], t1);
        assertEq(mine[1], t3);

        address[] memory theirs = factory.tokensOf(creatorB);
        assertEq(theirs.length, 1);
        assertEq(theirs[0], t2);
    }

    // ---------------------------------------------------------------------
    // Name and symbol content rules
    // ---------------------------------------------------------------------

    function test_name_rejectsNullByte() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = string(abi.encodePacked("Bad", bytes1(0x00), "Name"));
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_name_rejectsNewline() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = "Bad\nName";
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_name_acceptsUtf8() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = unicode"Türk Lirası";
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(p);
        assertEq(IERC20Metadata(token).name(), unicode"Türk Lirası");
    }

    function test_name_rejectsLeadingSpace() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = " Duke";
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_name_rejectsTrailingSpace() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = "Duke ";
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_name_rejectsAllSpaces() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = _repeat(" ", 64);
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadName.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_name_acceptsInteriorSpace() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.name = "Duke Token";
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(p);
        assertEq(IERC20Metadata(token).name(), "Duke Token");
    }

    function test_symbol_rejectsSpace() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.symbol = "BAD SYM";
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadSymbol.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_symbol_rejectsCyrillic() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.symbol = unicode"USDС";
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadSymbol.selector);
        factory.createToken{value: FEE}(p);
    }

    function test_symbol_acceptsPunctuationAndDigits() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.symbol = "USD-T_2.0";
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(p);
        assertEq(IERC20Metadata(token).symbol(), "USD-T_2.0");
    }

    function test_symbol_16BytesPasses_17BytesReverts() public {
        TokenFactory.TokenParams memory p = _params(false, false, 0);
        p.symbol = _repeat("A", 16);
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(p);
        assertEq(IERC20Metadata(token).symbol(), _repeat("A", 16));

        p = _params(false, false, 0);
        p.symbol = _repeat("A", 17);
        vm.prank(creator);
        vm.expectRevert(TokenFactory.BadSymbol.selector);
        factory.createToken{value: FEE}(p);
    }

    // ---------------------------------------------------------------------
    // Registry paging that stays usable forever
    // ---------------------------------------------------------------------

    function test_tokenCountOf_and_tokensOfSlice() public {
        vm.startPrank(creator);
        address t0 = factory.createToken{value: FEE}(_params(false, false, 0));
        address t1 = factory.createToken{value: FEE}(_params(false, false, 0));
        address t2 = factory.createToken{value: FEE}(_params(false, false, 0));
        vm.stopPrank();

        assertEq(factory.tokenCountOf(creator), 3);

        address[] memory slice = factory.tokensOfSlice(creator, 1, 5); // clamps at the end of the list
        assertEq(slice.length, 2);
        assertEq(slice[0], t1);
        assertEq(slice[1], t2);

        address[] memory full = factory.tokensOfSlice(creator, 0, 2);
        assertEq(full.length, 2);
        assertEq(full[0], t0);
        assertEq(full[1], t1);

        address[] memory past = factory.tokensOfSlice(creator, 10, 5); // start past the end -> empty
        assertEq(past.length, 0);
    }

    function test_tokenCountOf_zeroForStranger() public view {
        assertEq(factory.tokenCountOf(address(this)), 0);
    }

    /// count = type(uint256).max must not make `start + count` overflow; the slice clamps at the list end.
    function test_tokensOfSlice_maxCount_doesNotOverflow_start0() public {
        vm.startPrank(creator);
        address t0 = factory.createToken{value: FEE}(_params(false, false, 0));
        address t1 = factory.createToken{value: FEE}(_params(false, false, 0));
        vm.stopPrank();

        address[] memory slice = factory.tokensOfSlice(creator, 0, type(uint256).max);
        assertEq(slice.length, 2);
        assertEq(slice[0], t0);
        assertEq(slice[1], t1);
    }

    function test_tokensOfSlice_maxCount_doesNotOverflow_start1() public {
        vm.startPrank(creator);
        factory.createToken{value: FEE}(_params(false, false, 0));
        address t1 = factory.createToken{value: FEE}(_params(false, false, 0));
        vm.stopPrank();

        address[] memory slice = factory.tokensOfSlice(creator, 1, type(uint256).max);
        assertEq(slice.length, 1);
        assertEq(slice[0], t1);
    }

    // ---------------------------------------------------------------------
    // Constructor guards
    // ---------------------------------------------------------------------

    function test_constructor_rejectsZeroFeeController() public {
        vm.expectRevert(TokenFactory.ZeroFeeController.selector);
        new TokenFactory(IFeeController(address(0)));
    }

    function test_constructor_probesFeeKey_revertsWhenMissing() public {
        FeeController freshFees = new FeeController(address(this), recipient);
        // MINT_FLAT was never added on freshFees, so a factory built on top of it would be dead forever
        vm.expectRevert(abi.encodeWithSelector(FeeController.UnknownKey.selector, keccak256("MINT_FLAT")));
        new TokenFactory(freshFees);
    }
}
