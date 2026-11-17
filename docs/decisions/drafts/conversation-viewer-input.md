> DRAFT: not accepted, not current truth.

# NNNN. The conversation viewer follows the agent and steers or stops it on request

## Context

A user watches an agent while it works, and new output arrives at the bottom. A user who scrolls up to read earlier output loses their place if each new line moves the view down.

A user who sees an agent go wrong wants to correct or stop it without leaving the transcript. ADR 0034 routes every stop through `abort()` with a `stopCause`. A stop discards the agent's work, so a single stray key must not cause one.

In pi's main session, `Esc` interrupts the agent. In an overlay, `Esc` also means leave, so one key cannot carry both meanings.

## Decision

The viewer's keys live in `src/ui/conversation-viewer.ts` and `src/ui/viewer-keys.ts`.

### Follow

1. Follow is on when the viewer opens. While follow is on, the view shows the latest message.
2. After any scroll key, follow is on exactly when the view shows the latest line.
3. `Home` goes to the start of the conversation. `End` goes to the latest message and turns follow on.
4. While follow is off, the footer says so and names `End`.

### Steer and stop

1. The viewer offers steer and stop only while the agent is `running` or `queued`. Once the agent settles, `Enter` and `x` do nothing and the footer omits them.
2. `Enter` opens a pi `CustomEditor` input box, styled like the main session's. In it, `Enter` sends the trimmed text if it is not empty, and `Esc` closes only the input box. The input box takes every key while open.
3. A sent steer shows as a dim `Steering: <text>` line below the transcript until the agent's session takes it from its steering queue.
4. `Esc` never stops the agent. Stop needs two presses of `x`: the first arms it and the footer shows the armed state, and any other key disarms it. The second `x` calls `abort(id, "user")`.
5. The viewer offers steer and stop for nested agents too (ADR 0007).

### Keys

1. `Esc`, `Ctrl+C`, and `q` close the viewer while no input box is open.
2. Scroll keys come from pi keybindings: `tui.select.up` and `tui.select.down` move one line, and `tui.select.pageUp` and `tui.select.pageDown` move one page. `k`, `j`, `Shift+↑`, and `Shift+↓` also scroll.
3. `Home`, `End`, `Enter`, `x`, `Esc`, `Ctrl+C`, and `q` do not follow pi keybindings.
4. The footer names scroll and expand keys by the key that the active pi keybinding binds, and names the other keys as they are.

Done check: `npx vitest run test/ui/conversation-viewer.test.ts test/ui/conversation-viewer-keybindings.test.ts` passes, with a test for each rule above.

## Consequences

- The user can steer or stop a nested agent that its owner waits on. The owner then gets the result the steered run produces, or a `stopped` result with `stopCause` `user`.
- A user used to `Esc` as interrupt in pi must learn `x x` in the viewer.
- Revisit if pi adds a standard interrupt key that does not double as leave.
