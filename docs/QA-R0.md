# ARC.os R0 — manual QA script

For the project owner to run by hand: first on testnet, then again on mainnet once
`ARCOS.mainnet` is filled in (see `packages/contracts/DEPLOY.md`). Items marked **(no wallet
needed)** were already exercised against `npm run dev` while writing this script and behave as
described below. Everything else needs a browser wallet (any EIP-6963 extension — MetaMask,
Rabby, etc. — WalletConnect is not supported) holding testnet USDC from
https://faucet.circle.com, and the contracts deployed per `packages/contracts/DEPLOY.md`, so it
is left for the owner to run once those two things exist.

Swap needs the same testnet wallet as the rest of this script. Bridge additionally needs that
wallet holding testnet USDC on an EVM testnet other than Arc (Ethereum Sepolia is the one used
below) — get it from https://faucet.circle.com or the relevant chain's own faucet — and, if you
want to see it charge a fee, `NEXT_PUBLIC_FEE_RECIPIENT` set to an address you can check the
balance of afterward. Both run against Circle's App Kit SDK in keyless mode (see the "Swap and
Bridge" section below for what to check, including the fee split).

## Desktop **(no wallet needed)**

1. Fresh browser tab, no wallet extension (or wallet disconnected): the desktop loads with four
   category trays — System, Trust, Create, Trade — each holding its real and coming-soon icons,
   and the dock pins Finder, Inspector, Mint, Drop, Wallet. Nothing overlaps the dock or the menu
   bar; a tray that runs past the bottom of the screen scrolls, it doesn't clip. Checked at
   1280×800 and 1440×900.
2. Open Inspector, paste the testnet EURC address
   (`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`), click Inspect. Expect: window title becomes
   "Inspector — EURC", 8 findings render, the badge reads "N of 8 checks pass" (never a numeric
   score), every finding with an evidence link resolves to `explorer.testnet.arc.io`. No wallet
   prompt at any point.
3. Open Mint (no wallet): shows "Connect a wallet to use this app." and an "Open Wallet" button,
   not a form.
4. Open Drop (no wallet): the same gate.
5. Load `http://localhost:3000/#app:inspector?token=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
   directly: Inspector opens on page load, pre-filled, and runs automatically — no click needed.

## Keyboard **(no wallet needed)**

6. Using a real keyboard in a normal browser tab — this couldn't be confirmed by the automated
   pass that checked the rest of this list, since its browser-driving tool has no way to send real
   keyboard focus/activation events — Tab steps through every desktop icon, dock tile, menu-bar
   item and window control, in a sensible order, and focus stays visible (a clear outline or ring)
   at every step, never invisible or just a subtle color change. Esc closes the active window.
   ⌘K (Ctrl+K on Windows/Linux) opens the launcher from anywhere. Enter and Space activate a
   focused tray icon and a focused dock tile — this last part is expected to work without
   needing to be exercised here, since both are native `<button>` elements and the browser gives
   them Enter/Space activation for free.

## Wallet

7. Connect: the Wallet window lists every EIP-6963 wallet the browser actually announces (not
   just a generic "Injected" entry) when more than one extension is installed. Approve in the
   extension; the window switches to the connected view (address link, network, balance,
   Disconnect).
8. Once connected on Arc Testnet, the menu bar's right side shows the short address and, within
   about 15 seconds, `· N USDC`.
9. Connect while the wallet is on a different chain: the menu bar reads "Switch to Arc Testnet"
   (underlined); clicking it, or the same button inside a gated app's "Your wallet is on another
   network." panel, prompts the wallet to add/switch networks and flips back to normal once it
   succeeds.
10. Disconnect from the Wallet window returns the menu bar to "Connect wallet".

## Inspector

11. Inspect a non-contract address (e.g. `0x0000000000000000000000000000000000000001`): renders
    "No contract at that address.", window title stays "Inspector".
12. Force the explorer unreachable for one inspection (or just run this from a server context on
    mainnet, which is documented as 403-ing non-browser clients): the affected findings read
    "unknown" — never guessed as pass or fail — and a banner reads "The explorer didn't answer, so
    some checks are marked unknown."
13. Click "Share proof page": the clipboard gets `http://<host>/t/<address>`. Open that link in a
    tab with JavaScript disabled — the page still renders (it's server-rendered), with the same
    findings, an "Open in ARC.os" link back to the app, and the disclaimer line.
14. Load `/badge/<address>` directly: the response is an `image/svg+xml` badge, not an app page.
15. Check the social card: fetching `/t/<address>` with a link-preview tool (or `curl -s
    .../t/<address> | grep -i og:image`) shows an `opengraph-image` that reflects the same token.
16. A mintable token you haven't renounced ownership of shows "Owner can mint new supply" under
    ownership/privileges. Call `renounceOwnership()` on that token (an EOA-owned `MintableToken`
    supports it, unlike `FeeController`), reinspect, and confirm the finding now reads ownership
    renounced / no privileged functions reachable.
17. Rate limit, per IP **(no wallet needed — already verified against `npm run dev`)**: 30 rapid
    requests to `/api/inspect/<address>` from one IP succeed (or 404/whatever the address resolves
    to); the 31st within the same minute returns `429` with a `retry-after` header. Confirmed
    locally: a loop of 35 requests returned `404` for the first 30 and `429` for the last 5, with
    `retry-after: 53` on the 429s.
18. Backpressure, per instance **(no wallet needed)**: this is a second, separate limiter from
    item 17 above — it caps concurrent *uncached* inspections across the whole server instance at
    8, regardless of which IP they come from, rather than capping requests per IP over a minute.
    Provoke it with a shell loop that fires more than 8 requests for different, real token
    addresses at once — e.g. about 20 distinct testnet token addresses in parallel — so more of
    them land while the gate is still full than a smaller batch would guarantee. Split them across
    two source IPs (or just keep each IP's share comfortably under 30 within that minute) so item
    17's per-IP limiter doesn't also fire and confuse the result: a `429` in the responses means
    you hit item 17's throttle instead, while a `503` with a `retry-after: 5` header means you hit
    this gate. Expect: once more than 8 uncached inspections are in flight at the same moment, the
    excess requests get `503`; loading the proof page (`/t/<address>`) for one of those addresses
    while the gate is saturated shows "ARC.os is busy reading other tokens. Reload in a few
    seconds."; and `/badge/<address>` for a saturated address falls back to the neutral
    "ARC.os: not inspected" grey badge rather than caching a broken result for five minutes.

## Mint

19. Create a fixed-supply token (e.g. name "Duke", symbol "DUKE", supply "1,000,000", decimals
    18, both checkboxes off): exactly one wallet prompt for 15 USDC (as native value) plus gas —
    confirm the requested value matches the fee shown on the submit button. After signing, the
    window shows "DUKE is live" with a working explorer link.
20. Create a token with 6 decimals (matching the ERC-20 USDC convention): the same flow works,
    and both Finder's balance and Inspector's report display it at the right scale — not off by
    factors of 10^12 against the 18-decimal fixed-supply case above.
21. Create a mintable token, no cap: Inspector shows "Owner can mint new supply"; the effective
    cap resolves to uncapped. With an explicit cap above supply, minting above it should revert
    (once a mint-more UI exists to try it).
22. Create a burnable token: the deployed contract is the burnable template — the holder can burn
    their own balance, there's no mint/owner function to find.
23. Click "Inspect it" on a freshly minted fixed-supply token: 8 findings, "No privileged
    functions found", "No owner function".

## Drop

24. Drag a real `.csv` file from the computer onto the Recipients textarea (not pasted text): its
    contents load into the list, a plain `address,amount` header row is recognized and skipped
    automatically, the row/total counts update.
25. Include a contract address with no `receive()` among the recipients of a native (USDC) drop:
    that row's value transfer fails and refunds to the sender; the result panel lists it under
    "N delivered" as a failed row reading "Line `<n>`: `<short address>`", where `<n>` is that
    row's actual line number in the pasted/CSV list — not its position within whichever batch it
    fell into.
26. Paste a list of more than 200 recipients: it splits into multiple `sendNative`/`sendToken`
    calls (200 per batch; the contract itself refuses more than 400 in one call, sized to Arc's
    30,000,000 block gas limit). The Send button's label steps through "Sending batch 1 of N…",
    "Sending batch 2 of N…", etc.
27. On a list that splits into 3 batches, reject the wallet prompt on batch 2: afterwards the
    textarea holds only the rows that never landed — batch 1's delivered rows are gone from the
    list, batch 2 and batch 3's rows remain — so pressing Send again resends only what's left, not
    the whole original list.
28. After a drop with failures, click "Copy failed rows", then paste the clipboard back into the
    textarea: the addresses and amounts match what was originally typed for those rows.
29. Check the fee line above Send: "Fee `<amount>` USDC · charged per recipient, including
    transfers that fail · `<n>` transaction(s)" — confirms the fee is charged per row submitted,
    not per row that actually lands.
30. Gas measurement on real hardware: send a real 200-recipient native drop on testnet, then read
    the transaction's `gasUsed` (`cast receipt <hash> --rpc-url arc_testnet` or the explorer) and
    compare it against the block gas limit (`cast block latest --rpc-url arc_testnet` →
    `gasLimit`, expected 30,000,000). This confirms the Foundry-measured "~14.1M gas for 400 fresh
    native recipients" the app's `BATCH = 200` sizing is based on (see
    `apps/web/src/apps/drop/parse.ts`) actually holds on the live network, not just in a local
    Anvil fork.
31. Known open question (from `packages/contracts/DEPLOY.md`): if a *recipient* (not the fee
    recipient) in a native drop is a blocklisted address on Arc, confirm whether only that row
    fails — the same skip-and-refund behavior as any other failing transfer — or whether the
    whole transaction reverts. This can only be checked on testnet against a real
    Circle-documented blocklisted test address, if one is published; it cannot be reproduced
    locally because the blocklist is an Arc network policy, not something Anvil enforces.

## Finder

32. With the wallet holding EURC (and ideally a self-created token), open Finder: EURC and any
    other ERC-20 holdings appear as files with their symbol; tokens created here appear first,
    newest first, each tagged "created by you"; the rest are sorted by symbol.
33. Drag a token file from Finder onto the Inspector tray icon, its dock tile, and an already-open
    Inspector window: each opens or updates a window titled "Inspector — `<symbol>`".
34. Select a token file and click "Send with Drop": opens Drop pre-filled with that token
    (skipping the USDC/Another-token picker).

## Proof page and badge, for a token minted here

35. Mint a token in this session, open its proof page (`/t/<address>`) and badge
    (`/badge/<address>`) using the flows above (Inspector's "Share proof page", or the URL
    directly): the proof page shows the token's own name/symbol and findings, and the badge SVG
    reflects the same check counts as the Inspector window.

## Swap and Bridge

36. Open Swap with the wallet disconnected: the same "Connect a wallet to use this app." gate as
    every other trading app.
37. Connect, open Swap: pick USDC → EURC, type "1". Within about 400ms of the last keystroke an
    estimate appears — "You receive (estimated)" fills in, plus a "Minimum received" line and any
    fee lines App Kit's estimate itself reports. Picking EURC as the "You send" token (matching
    what's already selected as "You receive") swaps the two instead of letting both read EURC;
    the "Flip" button does the same swap directly. If `NEXT_PUBLIC_FEE_RECIPIENT` is set, a
    "Platform fee 0.20%" line is present; if it's unset (or malformed), that line is absent and no
    fee is charged — confirm both states by toggling the env var and restarting `npm run dev`.
38. Type "1,5" into the amount box: `"1,5" isn't a number` appears (a comma is never read as a
    decimal point) and Swap is disabled. Clear it and type a valid amount to confirm the message
    clears and Swap re-enables.
39. Click Swap: one or two wallet prompts (App Kit handles any allowance itself — permit signature
    or an approve transaction — before the swap transaction). While it's in flight the button
    reads "Waiting for your wallet…" and the form is locked; a second click, or opening a second
    Swap window, does nothing until this one finishes. Once it lands: "Swap complete", the
    transaction hash (linking to `explorer.testnet.arc.io`), and the received amount if App Kit's
    result reports one. If `NEXT_PUBLIC_FEE_RECIPIENT` was set, check that address's USDC balance
    increased by about 0.0018 USDC on a 1 USDC swap (0.20% minus Arc's 10% share — i.e. the
    recipient keeps 90% of the 0.20% fee).
40. Close the Swap window mid-swap (right after clicking Swap, before it resolves) and reopen it:
    the in-flight state — or the result, once it lands — is still there, not a blank form. This is
    the session store surviving the window unmounting, the same pattern Drop uses.
41. Open Bridge with the wallet disconnected: the same connect gate.
42. Connect, open Bridge: "To Arc" is selected by default, "From" defaults to the first EVM chain
    in the list (Ethereum Sepolia on testnet). Check the chain select lists exactly six EVM chains
    (no Solana) matching the active network (mainnet or testnet, never a mix). Type "1" in Amount:
    "Fee 0.002 USDC (0.20%) · added on top" appears when `NEXT_PUBLIC_FEE_RECIPIENT` is set, absent
    when it isn't.
43. Click Bridge with the wallet on Arc Testnet and "To Arc" / Ethereum Sepolia selected: the
    wallet is prompted to switch to Ethereum Sepolia (App Kit's adapter drives this itself), then
    to approve/burn there; depending on whether Circle's Forwarder relays the mint, either no
    further prompt is needed or the wallet is asked to switch back to Arc Testnet for one more
    signature. This can take a few minutes — the window says so and stays usable. Once it
    settles: each step App Kit's result reports (its name, state, and — where present — a
    transaction hash linking to that chain's own explorer) is listed, and the headline reads
    "Bridge complete", "Still finishing on the destination chain", or "Bridge didn't complete"
    depending on the result's `state` — never a guessed "complete" the SDK didn't actually report.
    If `NEXT_PUBLIC_FEE_RECIPIENT` was set, confirm that address's USDC balance on Ethereum Sepolia
    (the source chain — bridge fees are charged there, added on top of the transfer) increased by
    about 0.0018 USDC.
44. Close the Bridge window mid-transfer and reopen it (or open a fresh Bridge window): the
    in-flight state, or the settled result, is still there — closing the window never orphans a
    transfer that already burned funds on the source chain. Closing or reloading the tab itself
    prompts the browser's native "leave site?" warning while a bridge is in flight.
45. Known simplification, not a bug: Bridge shows live progress only as "Bridging — this can take
    a few minutes" while the SDK's single `kit.bridge()` call is in flight, then the full step list
    once it settles — it does not subscribe to App Kit's per-step event stream for a live
    approve/burn/attest/mint ticker.

## Phone width

46. At about 390px wide with touch emulation: the desktop becomes a single searchable list of
    every app grouped by the same four categories; tapping an app opens it full screen; the
    minimize (–) control returns to the list; Inspector's, Mint's, Drop's, Swap's and Bridge's
    forms fit the width with no horizontal scrolling. (Verified for Inspector as shipped, and for
    Mint, Drop, Swap and Bridge with their wallet/deployment gates temporarily bypassed locally
    and reverted.)

## Before mainnet — gate list

- [ ] Every testnet item above passes.
- [ ] `ARCOS_FEE_RECIPIENT` is a plain payable address — an EOA, or a multisig whose
      `receive()`/fallback can't revert.
- [ ] `FeeController`'s owner is a wallet you can't lose. Renouncing is disabled by design (it's
      the only recovery lever if the fee recipient ever stops accepting value), so there is no
      way to recover a lost owner key.
- [ ] `NEXT_PUBLIC_ARC_NETWORK=mainnet` is set only after `ARCOS.mainnet` in
      `packages/chain/src/addresses.ts` is filled in with the real deployed addresses.
- [ ] GitHub private vulnerability reporting is enabled in the repository settings.
- [ ] The About window and README state the contracts are unaudited.
