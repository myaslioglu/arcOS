// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ArcVesting} from "../../src/vesting/ArcVesting.sol";
import {MockToken} from "../vault/mocks/VaultMocks.sol";
import {VestingTestBase} from "./VestingTestBase.sol";

/// What a vesting wallet reports as vested, for a grid of schedules and moments, written to test/vectors/vesting.json.
/// The ArcOS Vesting window draws its curve with a TypeScript copy of this arithmetic (`schedulePreview`), and its
/// tests check that copy against every case in the file, so the contract and the window are held to the same numbers.
/// This test builds the file again from the real contract and fails if the committed one differs. After a change to
/// the contract or to the grid, rewrite it with `npm run vectors` in packages/contracts.
/// Only that profile may write the file: in the default one the write is refused, so an exported
/// WRITE_VESTING_VECTORS can never make this test pass without checking.
contract VestingVectorsTest is VestingTestBase {
    string internal constant PATH = "test/vectors/vesting.json";

    struct Base {
        uint256 amount;
        uint64 start;
        uint64 duration;
        uint64 cliff;
    }

    function _bases() internal view returns (Base[] memory b) {
        uint256 maxAmount = factory.MAX_AMOUNT();
        uint64 maxDuration = factory.MAX_DURATION();
        b = new Base[](17);
        // The smallest schedules: one wei, one second.
        b[0] = Base(1, 1_000_000, 1, 0);
        b[1] = Base(1, 1_000_000, 1, 1);
        // A year, with no cliff, a 90-day cliff and a cliff as long as the schedule.
        b[2] = Base(1000 ether, 1_800_000_000, 365 days, 0);
        b[3] = Base(1000 ether, 1_800_000_000, 365 days, 90 days);
        b[4] = Base(1000 ether, 1_800_000_000, 365 days, 365 days);
        // Rounding: odd durations and amounts that don't divide evenly.
        b[5] = Base(1_000_000, 1_800_000_000, 7, 3);
        b[6] = Base(333, 1_800_000_000, 1_000_003, 12_345);
        b[7] = Base(7, 50, 3, 0);
        b[8] = Base(1_000_000_000_000_000_000_000_000_007, 1_700_000_000, 4 * 365 days + 1, 365 days);
        // The factory's limits: the largest amount and the longest schedule.
        b[9] = Base(maxAmount, 1_900_000_000, maxDuration, 0);
        b[10] = Base(maxAmount, 1_900_000_000, maxDuration, maxDuration / 3);
        b[11] = Base(maxAmount - 1, 1_900_000_000, maxDuration - 1, 1);
        b[12] = Base(maxAmount, 1_900_000_000, maxDuration, maxDuration);
        // A schedule that starts at zero, and one that began long ago.
        b[13] = Base(100, 0, 100, 0);
        b[14] = Base(12_345, 0, 100, 50);
        b[15] = Base(2 ** 200, 10, 1000, 999);
        b[16] = Base(5_000_000, 1_600_000_000, 2 * 365 days, 30 days);
    }

    /// The moments tried for a schedule: around the start, the cliff and the end, and far past it.
    function _moments(Base memory s) internal pure returns (uint64[] memory at) {
        uint64 cliffAt = s.start + s.cliff;
        uint64 end = s.start + s.duration;
        at = new uint64[](13);
        at[0] = s.start == 0 ? 0 : s.start - 1;
        at[1] = s.start;
        at[2] = s.start + 1;
        at[3] = cliffAt == 0 ? 0 : cliffAt - 1;
        at[4] = cliffAt;
        at[5] = cliffAt + 1;
        at[6] = s.start + s.duration / 2;
        at[7] = s.start + uint64((uint256(s.duration) * 2) / 3);
        at[8] = end - 1;
        at[9] = end;
        at[10] = end + 1;
        at[11] = end + 3650 days;
        at[12] = 0;
    }

    function _generate() internal returns (string memory out) {
        out = string.concat(
            "{\n",
            '  "about": "What an ArcVesting wallet reports as vested (vestedAmount(token, at)) for a schedule of `amount` '
            "tokens' smallest units, `start` and `at` in seconds, `duration` and `cliff` in seconds, with `cliff` counted from `start`. "
            "Numbers are decimal strings. Written by packages/contracts/test/vesting/VestingVectors.t.sol and read by "
            'apps/web/src/apps/vesting/__tests__/schedule.test.ts.",\n',
            '  "maxDuration": "',
            vm.toString(uint256(factory.MAX_DURATION())),
            '",\n',
            '  "maxAmount": "',
            vm.toString(factory.MAX_AMOUNT()),
            '",\n',
            '  "cases": [\n'
        );
        Base[] memory bases = _bases();
        bool first = true;
        for (uint256 i; i < bases.length; ++i) {
            Base memory s = bases[i];
            MockToken t = new MockToken();
            ArcVesting wallet = new ArcVesting(bob, s.start, s.duration, s.cliff);
            t.mint(address(wallet), s.amount);
            uint64[] memory moments = _moments(s);
            for (uint256 j; j < moments.length; ++j) {
                uint256 vested = wallet.vestedAmount(address(t), moments[j]);
                out = string.concat(
                    out,
                    first ? "" : ",\n",
                    '    { "amount": "',
                    vm.toString(s.amount),
                    '", "start": "',
                    vm.toString(uint256(s.start)),
                    '", "duration": "',
                    vm.toString(uint256(s.duration)),
                    '", "cliff": "',
                    vm.toString(uint256(s.cliff)),
                    '", "at": "',
                    vm.toString(uint256(moments[j])),
                    '", "vested": "',
                    vm.toString(vested),
                    '" }'
                );
                first = false;
            }
        }
        out = string.concat(out, "\n  ]\n}\n");
    }

    function test_vectors_matchTheCommittedFile() public {
        string memory generated = _generate();
        if (vm.envOr("WRITE_VESTING_VECTORS", false)) vm.writeFile(PATH, generated);
        assertEq(vm.readFile(PATH), generated, "test/vectors/vesting.json is out of date");
    }

    /// The edge cases the file must keep covering, whatever else the grid grows to.
    function test_grid_coversTheEdges() public view {
        Base[] memory bases = _bases();
        assertEq(bases[0].amount, 1); // one wei
        assertEq(bases[4].cliff, bases[4].duration); // cliff = duration
        assertEq(bases[2].cliff, 0); // no cliff
        assertEq(bases[9].amount, factory.MAX_AMOUNT()); // the largest amount
        assertEq(bases[9].duration, factory.MAX_DURATION()); // the longest schedule
    }
}
