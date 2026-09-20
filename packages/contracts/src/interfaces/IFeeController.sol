// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IFeeController {
    function feeOf(bytes32 key) external view returns (uint256);
    function recipient() external view returns (address payable);
}
