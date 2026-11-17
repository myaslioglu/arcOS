import type { NetworkId } from "@arcos/chain";

/**
 * Help's words, in one place so the tests can hold them to the copy rules: short plain sentences, the product named
 * ArcOS, no fee amounts (fees change, and each app shows its own before you sign), and nothing that promises what a
 * contract can't keep. What differs by network takes the network, so each site's guide is true where it is read.
 */

/** The section headings, in the order the guide shows them, and the short names its jump links use. */
export const SECTIONS = [
  { id: "what", heading: "What is ArcOS?", jump: "Intro" },
  { id: "start", heading: "Get started", jump: "Get started" },
  { id: "apps", heading: "What can I do here?", jump: "Apps" },
  { id: "protect", heading: "Protect your wallet", jump: "Protect" },
  { id: "words", heading: "Words to know", jump: "Words" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

/** "What is ArcOS?", in two sentences. */
export const WHAT_IS: readonly string[] = [
  "ArcOS is a desktop in your browser with simple tools for tokens on Arc, Circle's blockchain.",
  "Apps open in windows like on a computer, and the network fee (gas) is paid in USDC, a digital dollar.",
];

export type StartStep = {
  key: "wallet" | "network" | "usdc" | "connect";
  title: string;
  text: string;
  /** A link out, such as the testnet faucet. */
  link?: { label: string; href: string };
  /** An app the step needs, with the button that opens it. */
  app?: { label: string; id: string };
};

/** Circle's faucet for test USDC, which serves Arc Testnet. */
export const FAUCET_URL = "https://faucet.circle.com";

/** "Get started", in four steps. `chainName` is the active chain's own name ("Arc", "Arc Testnet"), as the switch button says it. */
export function startSteps(network: NetworkId, chainName: string): StartStep[] {
  return [
    {
      key: "wallet",
      title: "Get a wallet",
      text: "A wallet is an app that holds your tokens and signs what you approve. Use the one you already have, in your browser or on your phone. It stays yours: ArcOS never sees or holds your keys.",
    },
    {
      key: "network",
      title: `Switch to ${chainName}`,
      text: `Wallets often start on another network. If yours does, ArcOS shows a Switch to ${chainName} button, and your wallet asks you to confirm.`,
    },
    network === "testnet"
      ? {
          key: "usdc",
          title: "Get some test USDC",
          text: "Every transaction pays a network fee in USDC. On this testnet site that is test USDC, which you can get from Circle's faucet. Test tokens have no value.",
          link: { label: "Open Circle's faucet", href: FAUCET_URL },
        }
      : {
          key: "usdc",
          title: "Keep some USDC",
          text: "Every transaction pays a network fee in USDC, so keep some in your wallet. Is your USDC on another network? Bridge moves it to Arc.",
          app: { label: "Open Bridge", id: "bridge" },
        },
    {
      key: "connect",
      title: "Connect",
      text: "Press Connect wallet at the top, pick your wallet and approve. Then open any app. Nothing is sent until you confirm it in your wallet, and ArcOS shows its fees before you sign.",
      app: { label: "Open Wallet", id: "wallet" },
    },
  ];
}

/** Above the app cards. */
export const APPS_LEAD = "The apps sit in folders on the desktop. Here is what each one is for.";

/** What an app does, and when you would reach for it. */
export type AppGuide = {
  what: string;
  /** When you would reach for it, as a sentence that starts "Use it". */
  when: string;
  /** Reads data only Arc mainnet has (an index, a counter, watches): on the testnet site its card says so. */
  mainnetOnly?: true;
};

/**
 * One card per app, keyed by app id. The guide lists the apps the registry lists on this site, so an app without an
 * entry here still gets a card (its manifest's blurb); the tests ask for an entry for every app.
 */
export const APP_GUIDE: Readonly<Record<string, AppGuide>> = {
  finder: {
    what: "Shows the tokens in your wallet, and the ones you made, as files.",
    when: "Use it to see what you hold, or to drag a token onto another app.",
  },
  wallet: {
    what: "Connects your wallet and shows your USDC balance.",
    when: "Use it to connect, to switch to Arc, or to disconnect.",
  },
  about: {
    what: "Says what ArcOS is, which contracts it uses and what the fees are today.",
    when: "Use it when you want the details before you sign.",
  },
  stats: {
    what: "Shows how much ArcOS is used, with numbers you can check yourself.",
    when: "Use it when you are curious how many tokens and drops were made.",
    mainnetOnly: true,
  },
  revoke: {
    what: "Lists the approvals your wallet has given and takes them back.",
    when: "Use it when you stopped using an app, or an approval looks wrong.",
  },
  terminal: {
    what: "Opens apps and reads the chain from typed commands. It never signs or sends anything.",
    when: "Use it when you would rather type than click.",
  },
  inspector: {
    what: "Reads a token's contract and tells you what it can do to holders, like make more tokens or stop you from selling.",
    when: "Use it before you buy a token you don't know.",
  },
  watchdog: {
    what: "Watches tokens you hold and sends you a Telegram message when one of them changes.",
    when: "Use it when you hold a token and want to hear about changes to it.",
    mainnetOnly: true,
  },
  vault: {
    what: "Locks tokens or liquidity until a date you choose, so they can't be withdrawn early.",
    when: "Use it to show buyers your project's liquidity can't be withdrawn early, or to lock your team's own tokens.",
  },
  vesting: {
    what: "Pays tokens out little by little on a schedule, to one person or a list.",
    when: "Use it when you pay a teammate or an investor over months or years.",
  },
  mint: {
    what: "Creates your own token in a few steps, with no code.",
    when: "Use it to start a token for a project or a community.",
  },
  drop: {
    what: "Sends a token to many wallets at once, from a list.",
    when: "Use it when you pay a team, reward a community or send an airdrop.",
  },
  swap: {
    what: "Swaps between USDC, EURC (a digital euro) and cirBTC (a bitcoin token).",
    when: "Use it when you hold one of these tokens and need another.",
  },
  bridge: {
    what: "Moves USDC between Arc and other networks.",
    when: "Use it when your USDC is on another network and you need it on Arc, or the other way round.",
  },
  radar: {
    what: "Lists new tokens on Arc as they appear, each with Inspector's checks.",
    when: "Use it to see what launched lately, with the facts next to each token.",
    mainnetOnly: true,
  },
};

/** Under the app cards. */
export const NOT_ADVICE = "Inspector's checks are automated analysis, not investment advice.";

/** On a mainnet-only app's card, on the testnet site. */
export const MAINNET_ONLY = "Mainnet only";

export type Tip = { key: "phrase" | "read" | "inspect" | "revoke" | "testnet"; text: string };

/** "Protect your wallet". */
export function tips(network: NetworkId): Tip[] {
  return [
    {
      key: "phrase",
      text: "Never share your recovery phrase, the secret words that open your wallet. ArcOS will never ask for it, and no real helper will.",
    },
    { key: "read", text: "Read what your wallet shows before you confirm. If you didn't start it, reject it." },
    { key: "inspect", text: "Check a token with Inspector before you buy it." },
    { key: "revoke", text: "Use Revoke to take back approvals you no longer need." },
    ...(network === "testnet"
      ? [{ key: "testnet" as const, text: "This is the testnet site. Test tokens have no value, so it is a good place to try things out." }]
      : []),
  ];
}

/** "Words to know": each term once, in plain words. */
export const GLOSSARY: readonly { term: string; meaning: string }[] = [
  { term: "Wallet", meaning: "An app that holds your tokens and signs for you. Its recovery phrase is the master key." },
  { term: "Token", meaning: "A digital asset on a blockchain, like USDC or a project's own coin." },
  { term: "Gas", meaning: "The fee the network charges for each transaction. On Arc it is paid in USDC." },
  { term: "Approval", meaning: "Your permission for an app or contract to move a token for you. Revoke can take it back." },
  { term: "LP token", meaning: "The receipt you get for adding liquidity to a trading pool. It lets you take your share back out." },
  { term: "Lock", meaning: "Tokens kept in a contract until a date, so they can't be withdrawn early. A lock is only as sound as its token." },
  { term: "Vesting", meaning: "Tokens that unlock little by little over time, sometimes after a wait called a cliff." },
];

/** At the foot of the guide. */
export const FOOTER = "Open this guide again any time from Help on the desktop.";
