"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { activeChain } from "@arcos/chain";
import { setThemePreference, useDesktop, useRegistry } from "@arcos/shell";
import { complete, runCommand, type TermEnv } from "./commands";
import { shouldFocusOnClick, shouldInterceptTab } from "./keyboard";
import * as log from "./log";
import styles from "./terminal.module.css";

const PROMPT = "4rc:~$";
/** This window's command history is kept only while it's open, capped so a very long session can't
 * grow it without bound. */
const MAX_HISTORY = 100;
/** A single typed line's cap. The browser enforces this on paste too. */
const MAX_INPUT = 512;

/**
 * The Terminal: typed commands that read the chain, open apps and set the theme (see commands.ts). It
 * never signs or sends anything. ↑ ↓ walk this window's history, Tab completes a command or an app
 * id (Shift+Tab, and Tab with nothing to complete, move focus instead — so the explorer link a
 * command printed stays reachable by keyboard), Ctrl L clears. Every answer sits under its own
 * command, in an id-keyed, clear-aware log (see log.ts); output is plain text, and the only links
 * are explorer links a command built itself.
 */
export default function TerminalWindow() {
  const chain = activeChain();
  const { list } = useRegistry();
  const { open } = useDesktop();
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const [state, setState] = useState<log.LogState>(log.emptyLog());
  const [input, setInput] = useState("");
  const [atEnd, setAtEnd] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [recall, setRecall] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const appIds = useMemo(() => list.map((m) => m.id), [list]);
  const matches = useMemo(() => complete(input, appIds), [input, appIds]);
  const completionWord = useMemo(() => {
    const [first] = matches;
    if (!first || !(first.length > input.length && first.startsWith(input))) return null;
    return first.split(" ").at(-1) ?? null;
  }, [matches, input]);

  // A terminal is for typing, so it takes focus when it opens.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [state.lines]);

  const syncCaret = (el: HTMLInputElement) => {
    setAtEnd(el.selectionStart === el.value.length && el.selectionEnd === el.value.length);
  };

  const run = (raw: string) => {
    const typed = raw.trim();
    if (!typed) return;
    const nextHistory = [...history, typed].slice(-MAX_HISTORY);
    setHistory(nextHistory);
    setRecall(null);
    const { state: submitted, id, epoch } = log.submit(state, typed);
    setState(submitted);
    const env: TermEnv = {
      apps: list,
      open: (appId, params) => open(appId, params),
      account: { address, chainId },
      chain: { id: chain.id, name: chain.name },
      read: {
        balance: async (target: Address) => {
          if (!client) throw new Error("No RPC client for this network.");
          return client.getBalance({ address: target });
        },
        latestBlock: async () => {
          if (!client) throw new Error("No RPC client for this network.");
          const block = await client.getBlock({ blockTag: "latest" });
          return {
            number: block.number,
            timestamp: block.timestamp,
            baseFeePerGas: block.baseFeePerGas ?? null,
            txCount: block.transactions.length,
          };
        },
      },
      setTheme: setThemePreference,
      history: nextHistory,
      now: () => Date.now(),
    };
    void runCommand(typed, env).then((outcome) => {
      setState((prev) => (outcome.clear ? log.clear(prev) : log.answer(prev, id, epoch, outcome)));
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run(input);
      setInput("");
      return;
    }
    if (e.key === "Tab") {
      if (!shouldInterceptTab(e.shiftKey, matches)) return;
      e.preventDefault();
      if (matches.length === 1) setInput(`${matches[0]} `);
      else setState((prev) => log.note(prev, matches.map((m) => m.split(" ").at(-1)).join("   ")));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      const next = recall === null ? history.length - 1 : Math.max(0, recall - 1);
      setRecall(next);
      setInput(history[next]);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (recall === null) return;
      const next = recall + 1;
      if (next >= history.length) {
        setRecall(null);
        setInput("");
      } else {
        setRecall(next);
        setInput(history[next]);
      }
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      setState((prev) => log.clear(prev));
    }
  };

  return (
    <div
      className={styles.screen}
      onClick={() => {
        if (shouldFocusOnClick(window.getSelection())) inputRef.current?.focus();
      }}
    >
      <div className={styles.scanlines} aria-hidden />
      <div className={styles.vignette} aria-hidden />
      <div className={styles.content}>
        <div ref={logRef} className={styles.log} role="log" aria-live="polite" aria-label="Terminal output">
          {state.lines.length === 0 && (
            <p className={`${styles.line} ${styles.dim}`}>4rc.OS terminal. Type help for the commands.</p>
          )}
          {state.lines.map((line, i) => (
            <p
              key={i}
              className={`${styles.line} ${line.kind === "in" ? styles.typed : line.kind === "err" ? styles.error : styles.answer}`}
            >
              {line.kind === "in" && <span className={styles.prompt}>{`${PROMPT} `}</span>}
              {line.href ? (
                <a className={styles.link} href={line.href} target="_blank" rel="noopener noreferrer">
                  {line.text}
                </a>
              ) : (
                line.text || " "
              )}
            </p>
          ))}
        </div>
        <div className={styles.inputRow}>
          <span className={styles.prompt} aria-hidden>
            {PROMPT}
          </span>
          <span className={styles.field}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setRecall(null);
                syncCaret(e.target);
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => syncCaret(e.currentTarget)}
              onClick={(e) => syncCaret(e.currentTarget)}
              onSelect={(e) => syncCaret(e.currentTarget)}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="go"
              maxLength={MAX_INPUT}
              placeholder="help"
              aria-label="Command"
              className={styles.input}
            />
          </span>
          <span className={styles.hint} aria-hidden>
            {atEnd && completionWord ? `Tab: ${completionWord}` : "Tab completes · ↑ history · Ctrl L clears"}
          </span>
        </div>
      </div>
    </div>
  );
}
