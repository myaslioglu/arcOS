import type { NetworkId } from "@arcos/chain";
import type { IntroContent } from "@/lib/intro";

/** Vault's standing sentences, in one place so the tests can hold them to the copy rules. */

/** What custody means, for a token lock. */
export const CUSTODY_TOKEN = "The tokens sit in a vault contract. Only the vault's owner can take them out, and only after the unlock date.";

/** What custody means, for a position lock. */
export const CUSTODY_POSITION =
  "The position sits in a vault contract. Only the vault's owner can take it out, and only after the unlock date. Until then the owner can still collect its trading fees.";

/** Under every state of the window. */
export const UNAUDITED = "Not audited yet. These vault contracts run on testnet until their audit is done.";

/** How a transfer of ownership works, under the Transfer form. */
export const TRANSFER_NOTE =
  "Ownership moves in two steps: the new owner accepts it in Vault. Until then you stay the owner, and you can cancel. Send them this vault's address.";

/** For a lock that was handed over, or a vault the wallet never had a part in. */
export const NOT_YOURS = "You don't own this vault, so you can only look.";

/**
 * The first-run explainer above Vault's sections ("What is Vault?"): what it does, who it is for, how it works in three
 * steps, and what it doesn't do. No fee amounts (the form reads them live), and the audit line only where it is true:
 * the testnet site, where Vault runs ahead of its audit.
 */
export function vaultIntro(network: NetworkId): IntroContent {
  return {
    title: "What is Vault?",
    lead: "Vault locks tokens away until a date you choose. They can't be withdrawn early, not even by you, and anyone can look the lock up on the explorer.",
    uses: [
      "A project locks its LP tokens (the receipt you get for adding liquidity to a pool), so buyers can see the liquidity can't be withdrawn early.",
      "A team locks its own tokens for a year, to show it is in for the long run.",
    ],
    steps: [
      "Pick what to lock: a token, an LP token or a liquidity position.",
      "Choose the unlock date.",
      "Confirm in your wallet. From the unlock date, press Withdraw in Your locks to take it back.",
    ],
    limits: [
      "A lock can't be cancelled. You can move the unlock date later, never earlier.",
      "Only the vault's owner can withdraw. You can hand a vault to someone else, and they accept it in Vault.",
      "A locked position still earns trading fees, and its owner can collect them before the unlock date.",
      "A lock is only as sound as its token: a token whose owner can freeze or take balances can still get around it. Check the token with Inspector.",
      "The fees are shown before you sign.",
      ...(network === "testnet" ? ["Not audited yet, so Vault runs on this testnet site only. Test tokens have no value."] : []),
    ],
  };
}
