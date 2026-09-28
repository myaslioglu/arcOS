"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import type { Address } from "viem";
import { activeChain } from "@arcos/chain";
import { setThemePreference, useDesktop, useRegistry } from "@arcos/shell";
import { complete, runCommand, type Line, type TermEnv } from "./commands";
import styles from "./terminal.module.css";

/** The scrollback keeps this many lines; older ones fall off the top. */
const MAX_LINES = 400;
const PROMPT = "4rc:~$";

/**
 * The Terminal: typed commands that read the chain, open apps and set the theme (see commands.ts). It never signs or
 * sends anything. ↑ ↓ walk this window's history (kept only while the window is open), Tab completes a command or an
 * app id, → takes the ghosted completion, Ctrl L clears. Output is plain text; the only links are explorer links a
 * command built itself.
 */
export default function TerminalWindow() {
  const chain = activeChain();
  const { list } = useRegistry();
  const { open } = useDesktop();
  const { address, chainId } = useAccount();
  const client = usePublicClient({ chainId: chain.id });
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [recall, setRecall] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const appIds = useMemo(() => list.map((m) => m.id), [list]);
  const ghost = useMemo(() => {
    const [first] = complete(input, appIds);
    return first && first.length > input.length && first.startsWith(input) ? first.slice(input.length) : "";
  }, [input, appIds]);

  // A terminal is for typing, so it takes focus when it opens.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const push = (more: Line[]) => setLines((prev) => [...prev, ...more].slice(-MAX_LINES));

  const run = (raw: string) => {
    const typed = raw.trim();
    if (!typed) return;
    const nextHistory = [...history, typed];
    setHistory(nextHistory);
    setRecall(null);
    push([{ kind: "in", text: typed }]);
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
      if (outcome.clear) setLines([]);
      else push(outcome.lines);
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
      e.preventDefault();
      const matches = complete(input, appIds);
      if (matches.length === 1) setInput(`${matches[0]} `);
      else if (matches.length > 1) push([{ kind: "out", text: matches.map((m) => m.split(" ").at(-1)).join("   ") }]);
      return;
    }
    if (e.key === "ArrowRight" && ghost && e.currentTarget.selectionStart === input.length) {
      e.preventDefault();
      setInput(input + ghost);
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
      setLines([]);
    }
  };

  return (
    <div className={styles.screen} onClick={() => inputRef.current?.focus()}>
      <div className={styles.scanlines} aria-hidden />
      <div className={styles.vignette} aria-hidden />
      <div className={styles.content}>
        <div ref={logRef} className={styles.log} role="log" aria-live="polite" aria-label="Terminal output">
          {lines.length === 0 && (
            <p className={`${styles.line} ${styles.dim}`}>4rc.OS terminal. Type help for the commands.</p>
          )}
          {lines.map((line, i) => (
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
              }}
              onKeyDown={onKeyDown}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="go"
              aria-label="Command"
              className={styles.input}
            />
            <span aria-hidden className={styles.mirror}>
              {input}
              <span className={styles.caret} />
              <span className={styles.dim}>{ghost}</span>
              {!input && !ghost && <span className={styles.placeholder}>help</span>}
            </span>
          </span>
          <span className={styles.hint} aria-hidden>
            Tab completes · ↑ history · Ctrl L clears
          </span>
        </div>
      </div>
    </div>
  );
}
