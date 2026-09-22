/* English copy dictionary. Shape must stay in sync with pt-br.ts. */
export const en = {
  meta: {
    title: 'crossagent — a pair for your coding agent',
    description:
      'crossagent pairs the coding agent in one tmux pane with the one next to it. One writes, the other pushes back, before you ever see the diff.',
    ogImageAlt: 'crossagent — your agent needs a second opinion',
  },
  header: {
    starAriaLabel: (stars: number | null) =>
      stars === null ? 'crossagent on GitHub' : `crossagent on GitHub, ${stars} stars`,
    langSwitchAriaLabel: 'Switch language',
  },
  hero: {
    title:
      '<span class="nb">Your agent</span><br><span class="nb">needs a <em class="reviews">second</em></span><br><em class="reviews">opinion.</em>',
    sub: '<strong>crossagent</strong> pairs the coding agent in one tmux pane with the one next to it. One writes, the other pushes back, before you ever see the diff.',
    forLabel: 'FOR',
    forText: 'developers who already run more than one coding agent, from different providers, side by side in tmux.',
    notForLabel: 'NOT FOR',
    notForText: 'a single agent, an IDE-only setup, or anything outside a terminal multiplexer.',
    cta: 'Install',
    driverEntry1: 'Migration written. Before shipping, checking with my pair that it follows the spec&hellip;',
    driverCall: 'Calling crossagent',
    driverEntry2: 'Peer wants a rollback path. Adding it.',
    driverEntry3: 'Update(migrations/0007_add_index.ts)',
    reviewerInput:
      'Hi Astra, Fable here. I just wrote the 0007_add_index migration. Check that it meets the spec.',
    reviewerLine1: 'Ran git diff --stat',
    reviewerLine2: 'Ran read 0007_add_index.ts',
    reviewerVerdict: '<span class="ln--verdict">VERDICT: ADJUST</span> The migration has no rollback. Add a down() step before shipping.',
  },
  steps: {
    heading: 'How it works.',
    lead1:
      'A coding agent reviewing its own work has the same blind spots twice. If you already run two harnesses side by side in tmux, a second opinion is sitting one pane over. You just had to paste between them by hand.',
    lead2:
      '<strong>crossagent</strong> turns that pane into a reviewer. The driver asks over MCP, the peer reads the repo and answers with a verdict, and nothing ships without the other one having a say.',
    ping: 'Both panes load the same server. Each one declares its pane, harness and repo.',
    brief: 'The driver briefs the peer once: same-level copilot, reads the repo, never writes.',
    discuss: 'Every plan and diff goes through discuss. The reply ends in one verdict.',
  },
  verdicts: {
    heading: 'It never just says yes.',
    lead1: 'Every reply from the peer ends in one line: the word <code>VERDICT</code> and one of four calls. The driver reads that line before it does anything else.',
    lead2: 'The peer is a same-level copilot, not an approver. It reads the repo, runs read-only checks and disagrees when it disagrees. Looping to consensus and escalating stay with the caller. <strong>crossagent</strong> never decides for you.',
    agreeDef: 'No corrections. Go ahead and build it.',
    agreeNext: 'The driver ships it as is.',
    adjustDef: 'Fine once the listed items are fixed.',
    adjustNext: 'The driver fixes them, or argues back when one is wrong.',
    objectDef: 'Do not proceed as written. The reasons come with it.',
    objectNext: 'The driver reworks the plan and asks again.',
    escalateDef: 'Only the human can call this one.',
    escalateNext: 'The driver stops and brings it to you.',
    unparsedDef: 'Not a verdict. The reply had no readable <code>VERDICT</code> line.',
    unparsedNext: 'The driver asks again.',
  },
  install: {
    heading: 'Install.',
    step1: '1 &middot; Add the MCP',
    claudeCodeTitle: 'Claude Code',
    claudeCodeCopyLabel: 'Copy Claude Code command',
    codexTitle: 'Codex CLI',
    codexCopyLabel: 'Copy Codex CLI command',
    step2: '2 &middot; Link the pair skill',
    linkCopyLabel: 'Copy link skill command',
    copy: 'copy',
    copied: 'copied',
    selectAndCopy: 'select & copy',
    foot: 'Using another coding agent? <strong>crossagent</strong> only needs a harness that runs in a tmux pane. Add yours and <a class="install__link" href="https://github.com/k8adev/crossagent" rel="noopener">open a pull request</a>.',
  },
  footer: {
    siteAriaLabel: 'Site footer',
    sectionsAriaLabel: 'Sections',
  },
} as const;
