import type { NetworkId } from "@arcos/chain";
import type { IntroContent } from "@/lib/intro";

/** Words the window uses in more than one place, kept together so they can be read (and tested) as one piece. */

/** Under the New schedule form: what creating a schedule does. */
export const HOW_IT_WORKS =
  "The tokens move into a vesting contract made for the beneficiary. They unlock over time, and a release always pays the contract's current owner (the beneficiary). A schedule can't be cancelled or changed. The beneficiary can hand the contract to another address. Handing it over takes one step, so check the address.";

/** Always visible, under both tabs. */
export const AUDIT_NOTE = "These contracts have not been audited yet. They run on testnet first, ahead of the audit.";

/** Under the Your schedules list. */
export const YOURS_NOTE =
  "Lists the schedules made for your address. Anyone can start a release, but the tokens always go to the wallet's owner.";

/** Under "Open a vesting contract by address": what may be opened. Its token comes from ArcOS's record of the contract. */
export const ADD_BY_ADDRESS_NOTE =
  "For a vesting contract that was handed to you. ArcOS must have created it, and you must own it now. Its token is the one ArcOS recorded when the contract was made.";

export const NOT_DEPLOYED = "Vesting isn't deployed on this network yet.";

/**
 * The first-run explainer above Vesting's sections ("What is Vesting?"): what it does, who it is for, how it works in
 * three steps, and what it doesn't do. No fee amounts (the form reads them live), and the audit line only where it is
 * true: the testnet site, where Vesting runs ahead of its audit.
 */
export function vestingIntro(network: NetworkId): IntroContent {
  return {
    title: "What is Vesting?",
    lead: "Vesting pays tokens out little by little. The tokens go into a contract made for the person you pay, the beneficiary, and unlock evenly over the time you set. They release what has unlocked whenever they like.",
    uses: [
      "A founder pays a teammate tokens that unlock over two years.",
      "An investor gets tokens with a one-year cliff: nothing unlocks in the first year, then they catch up at once and keep unlocking bit by bit.",
      "A team pays many people from a list, one schedule each.",
    ],
    steps: [
      "Pick the token, then who gets it and how much: one person or a list.",
      "Set the start, how long it runs and an optional cliff. The chart shows how it unlocks.",
      "Confirm in your wallet. Then the beneficiary releases what has unlocked, in Your schedules.",
    ],
    limits: [
      "A schedule can't be cancelled or changed once it is made.",
      "Released tokens always go to the contract's owner, the beneficiary, whoever presses Release.",
      "The beneficiary can hand the schedule to another address. Handing it over takes one step and can't be undone, so check the address.",
      "The fee is shown before you sign.",
      ...(network === "testnet" ? ["Not audited yet, so Vesting runs on this testnet site only. Test tokens have no value."] : []),
    ],
  };
}
