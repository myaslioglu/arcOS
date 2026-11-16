/** Words the window uses in more than one place, kept together so they can be read (and tested) as one piece. */

/** Under the New schedule form: what creating a schedule does. */
export const HOW_IT_WORKS =
  "The tokens move into a vesting contract made for the beneficiary. They unlock over time, and a release always pays the contract's current owner (the beneficiary). A schedule can't be cancelled or changed. The beneficiary can hand the contract to another address.";

/** Always visible, under both tabs. */
export const AUDIT_NOTE = "These contracts have not been audited yet. They run on testnet first, ahead of the audit.";

/** Under the Your schedules list. */
export const YOURS_NOTE =
  "Lists the schedules made for your address. Anyone can start a release, but the tokens always go to the wallet's owner.";

/** Under "Open a vesting contract by address": what may be opened. Its token comes from ArcOS's record of the contract. */
export const ADD_BY_ADDRESS_NOTE =
  "For a vesting contract that was handed to you. ArcOS must have created it, and you must own it now. Its token is the one ArcOS recorded when the contract was made.";

export const NOT_DEPLOYED = "Vesting isn't deployed on this network yet.";
