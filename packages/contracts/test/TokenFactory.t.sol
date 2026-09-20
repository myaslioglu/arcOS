// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {FeeController} from "../src/FeeController.sol";
import {TokenFactory} from "../src/TokenFactory.sol";
import {MintableToken} from "../src/tokens/MintableToken.sol";
import {BurnableToken} from "../src/tokens/BurnableToken.sol";

contract TokenFactoryTest is Test {
    FeeController internal fees;
    TokenFactory internal factory;
    address payable internal recipient = payable(makeAddr("recipient"));
    address internal creator = makeAddr("creator");
    uint256 internal constant FEE = 15 ether;

    event TokenCreated(
        address indexed creator, address indexed token, string name, string symbol, bool mintable, bool burnable
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
        return TokenFactory.TokenParams({
            name: "Duke",
            symbol: "DUKE",
            decimals: 18,
            initialSupply: 1_000_000 ether,
            mintable: mintable,
            burnable: burnable,
            cap: cap,
            holder: creator
        });
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
        vm.expectEmit(true, false, false, true);
        emit TokenCreated(creator, address(0), "Duke", "DUKE", false, false);
        vm.prank(creator);
        address token = factory.createToken{value: FEE}(_params(false, false, 0));
        address[] memory mine = factory.tokensOf(creator);
        assertEq(mine.length, 1);
        assertEq(mine[0], token);
        assertTrue(factory.isArcosToken(token));
        assertFalse(factory.isArcosToken(address(this)));
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
}
