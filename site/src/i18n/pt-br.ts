/* Brazilian Portuguese copy dictionary. Shape must stay in sync with en.ts. */
export const ptBr = {
  meta: {
    title: 'crossagent — um pair para o seu agente de código',
    description:
      'crossagent conecta o agente de código de um pane do tmux com o do pane ao lado. Um escreve, o outro contesta, antes de o diff chegar até você.',
    ogImageAlt: 'crossagent — seu agente precisa de uma segunda opinião',
  },
  header: {
    starAriaLabel: (stars: number | null) =>
      stars === null ? 'crossagent no GitHub' : `crossagent no GitHub, ${stars} estrelas`,
    langSwitchAriaLabel: 'Trocar idioma',
  },
  hero: {
    title:
      '<span class="nb">Seu agente</span><br><span class="nb">precisa de uma <em class="reviews">segunda</em></span><br><em class="reviews">opinião.</em>',
    sub: '<strong>crossagent</strong> conecta o agente de código de um pane do tmux com o do pane ao lado. Um escreve, o outro contesta, antes de o diff chegar até você.',
    forLabel: 'PARA',
    forText: 'devs que já rodam mais de um coding agent, de provedores diferentes, lado a lado no tmux.',
    notForLabel: 'NÃO É PARA',
    notForText: 'um único agente, um setup só de IDE, ou qualquer coisa fora de um multiplexador de terminal.',
    cta: 'Instalar',
    driverEntry1: 'Migration escrita. Antes de publicar, vou confirmar com meu par se ela segue a spec&hellip;',
    driverCall: 'Chamando crossagent',
    driverEntry2: 'O par quer um caminho de rollback. Adicionando.',
    driverEntry3: 'Update(migrations/0007_add_index.ts)',
    reviewerInput:
      'Oi Astra, aqui é o Fable. Acabei de escrever a migration 0007_add_index. Confere se ela atende a spec.',
    reviewerLine1: 'Ran git diff --stat',
    reviewerLine2: 'Ran read 0007_add_index.ts',
    reviewerVerdict: '<span class="ln--verdict">VERDICT: ADJUST</span> A migration não tem rollback. Adicione um passo down() antes de publicar.',
  },
  steps: {
    heading: 'Como funciona.',
    lead1:
      'Um coding agent revisando o próprio trabalho tem os mesmos pontos cegos duas vezes. Se você já roda dois harnesses lado a lado no tmux, uma segunda opinião está a um pane de distância. Só faltava colar entre eles na mão.',
    lead2:
      '<strong>crossagent</strong> transforma esse pane em revisor. O driver pergunta via MCP, o par lê o repositório e responde com um veredito, e nada vai pro ar sem o outro opinar.',
    ping: 'Os dois panes carregam o mesmo servidor. Cada um declara seu pane, harness e repositório.',
    brief: 'O driver briefa o par uma vez: copiloto do mesmo nível, lê o repositório, nunca escreve.',
    discuss: 'Todo plano e diff passa pelo discuss. A resposta termina em um veredito.',
  },
  verdicts: {
    heading: 'Ele nunca diz só sim.',
    lead1: 'Toda resposta do par termina em uma linha: a palavra <code>VERDICT</code> e uma de quatro chamadas. O driver lê essa linha antes de fazer qualquer outra coisa.',
    lead2: 'O par é um copiloto do mesmo nível, não um aprovador. Ele lê o repositório, roda checagens somente leitura e discorda quando discorda. Buscar consenso e escalar continuam com quem chamou. <strong>crossagent</strong> nunca decide por você.',
    agreeDef: 'Sem correções. Pode seguir e construir.',
    agreeNext: 'O driver publica como está.',
    adjustDef: 'Ok assim que os itens listados forem corrigidos.',
    adjustNext: 'O driver corrige, ou contesta quando um item está errado.',
    objectDef: 'Não prossiga como está escrito. Os motivos vêm junto.',
    objectNext: 'O driver refaz o plano e pergunta de novo.',
    escalateDef: 'Só o humano pode decidir esse.',
    escalateNext: 'O driver para e leva a decisão até você.',
    unparsedDef: 'Não é um veredito. A resposta não tinha uma linha <code>VERDICT</code> legível.',
    unparsedNext: 'O driver pergunta de novo.',
  },
  install: {
    heading: 'Instalar.',
    step1: '1 &middot; Adicione o MCP',
    claudeCodeTitle: 'Claude Code',
    claudeCodeCopyLabel: 'Copiar comando do Claude Code',
    codexTitle: 'Codex CLI',
    codexCopyLabel: 'Copiar comando do Codex CLI',
    step2: '2 &middot; Vincule a pair skill',
    linkCopyLabel: 'Copiar comando de vínculo da skill',
    copy: 'copiar',
    copied: 'copiado',
    selectAndCopy: 'selecionar & copiar',
    foot: 'Usa outro coding agent? <strong>crossagent</strong> só precisa de um harness que rode em um pane do tmux. Adicione o seu e <a class="install__link" href="https://github.com/k8adev/crossagent" rel="noopener">abra um pull request</a>.',
  },
  footer: {
    siteAriaLabel: 'Rodapé do site',
    sectionsAriaLabel: 'Seções',
  },
} as const;
