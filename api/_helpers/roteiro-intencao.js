// api/_helpers/roteiro-intencao.js
//
// DISCERNIMENTO — saber quando NÃO agir.
//
// Auditoria de 29/07: o chat tratava TUDO como ordem de edição. Medido em
// produção:
//   "não gostei"             → devolvia o roteiro igual, tela dizia "✅ atualizado"
//   "tá bom pra tiktok?"     → engolia a pergunta, nada respondido
//   "escreve sobre gatos"    → COLAVA a frase no fim do roteiro
//
// Aqui a mensagem é classificada ANTES de qualquer coisa. Dois ganhos:
//   • vago e fora_escopo são resolvidos SEM gastar chamada de IA
//   • pergunta ganha resposta em vez de virar reescrita
//
// Puro de propósito (sem rede/env) — testado em tests/unit/roteiro_intencao.
//
// REGRA DE OURO: na dúvida, 'ordem'. É o comportamento que já existia; errar
// pro lado conhecido é melhor que inventar recusa em cima de pedido legítimo.

function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── verbos que são claramente ordem de edição ───────────────────────────────
const VERBOS_EDICAO = /\b(encurt\w*|alonga\w*|aument\w*|diminu\w*|reduz\w*|corta\w*|cort[ae]|tira\w*|remov\w*|apaga\w*|troca\w*|substitu\w*|muda\w*|mude|altera\w*|ajusta\w*|adiciona\w*|acrescenta\w*|inclui\w*|poe|poem|coloca\w*|deixa\w*|deixe|torna\w*|reescreve\w*|refaz\w*|melhora\w*|simplifica\w*|resum\w*|expand\w*|detalha\w*|inverte\w*|comeca\w*|termina\w*|finaliza\w*|separa\w*|junta\w*|traduz\w*|corrig\w*|arruma\w*|ajeita\w*)\b/;

// ── pergunta ────────────────────────────────────────────────────────────────
const INICIO_PERGUNTA = /^(o que|oque|qual|quais|quando|onde|quem|como|por que|porque|pq|por quê|sera que|tem como|da pra|d[aá] para|voce acha|vc acha|acha que|isso (ta|esta)|esse roteiro (ta|esta)|ficou bom|ta bom|esta bom|vale a pena|posso|devo|preciso)\b/;

// ── reclamação/elogio sem direção ───────────────────────────────────────────
const VAGO = /^(nao gostei|n gostei|nao curti|ruim|pessimo|horrivel|feio|estranho|nao ficou bom|nao era isso|nao e isso|nao|nada a ver|hum+|eh|ok|blz|beleza|legal|bom|otimo|gostei|amei|top|show|perfeito|massa|valeu|obrigado|obrigada|vlw|oi|ola|opa|bom dia|boa tarde|boa noite|teste|testando)[.!]*$/;

// ── pedido que não é ajuste: quer OUTRO roteiro ─────────────────────────────
const FORA_ESCOPO = /\b(esquec\w+ (esse|este|o) roteiro|roteiro (totalmente )?novo|outro roteiro|do zero|come[cç]a de novo|apaga tudo|refaz tudo do zero|escrev[ae] (um|outro) (roteiro|texto) (novo|sobre)|fala sobre (outro|outra)|muda (o )?(tema|assunto))\b/;

export const INTENCOES = ['ordem', 'pergunta', 'vago', 'fora_escopo'];

/**
 * @param {string} msg  o que o usuário digitou
 * @returns {'ordem'|'pergunta'|'vago'|'fora_escopo'}
 */
export function classificar(msg) {
  const n = norm(msg);
  if (!n) return 'vago';

  // 1. Quer outro roteiro — não é ajuste deste aqui.
  if (FORA_ESCOPO.test(n)) return 'fora_escopo';

  // 2. Curto e sem direção ("não gostei", "oi", "top").
  //    Só vale pra mensagem CURTA: "não gostei do final, corta ele" é ordem.
  const palavras = n.split(' ').filter(Boolean);
  if (palavras.length <= 4 && VAGO.test(n)) return 'vago';

  // 3. Pergunta. Cuidado: "corta o final?" tem "?" mas é ordem.
  //    Verbo de edição tem precedência sobre ponto de interrogação.
  const temVerbo = VERBOS_EDICAO.test(n);
  if (!temVerbo && (n.endsWith('?') || INICIO_PERGUNTA.test(n))) return 'pergunta';

  // 4. Na dúvida, ordem — é o comportamento antigo, e o portão de sanidade
  //    segura o estrago se a IA fizer bobagem.
  return 'ordem';
}

// ── o que ele responde sem gastar IA ────────────────────────────────────────
export const RESPOSTA_VAGO = [
  'Preciso saber o que te incomodou. É o começo que não segura? Tá longo? Faltou tensão? Me aponta e eu ajeito.',
  'Fala o que tá ruim que eu resolvo: gancho fraco, muito longo, tom errado, final sem graça?',
  'Não adianta eu chutar. Me diz a parte que te incomodou — começo, meio ou fim — e o que tu queria no lugar.',
];

export const RESPOSTA_FORA_ESCOPO = [
  'Aqui eu só ajusto o roteiro que já tá na tela. Pra um roteiro novo, usa o Gerar do Zero ali em cima — não vou apagar esse teu sem querer.',
  'Roteiro novo do zero não é comigo nesta janela: eu edito o que já existe. Usa o Gerar do Zero que ele nasce limpo.',
];

export function respostaPronta(intencao, giro) {
  const lista = intencao === 'vago' ? RESPOSTA_VAGO
    : intencao === 'fora_escopo' ? RESPOSTA_FORA_ESCOPO
    : null;
  if (!lista) return null;
  const i = Math.abs(Number.isFinite(giro) ? giro : 0) % lista.length;
  return lista[i];
}

// ── memória: histórico que vai pro prompt ───────────────────────────────────
// Sem isso, "mais ainda" e "volta como estava" não têm a que se referir — e o
// medido em produção foi a IA colando "ainda mais" dentro do roteiro.
export function montarHistorico(historico, maxTrocas) {
  const lim = maxTrocas || 6;
  const lista = Array.isArray(historico) ? historico.slice(-lim) : [];
  if (!lista.length) return '';
  const linhas = lista
    .filter((m) => m && m.texto)
    .map((m) => (m.quem === 'user' ? 'USUÁRIO: ' : 'VOCÊ: ') + String(m.texto).slice(0, 300));
  if (!linhas.length) return '';
  return `CONVERSA ATÉ AQUI (pra você entender referências como "mais ainda", "de novo", "volta"):
${linhas.join('\n')}
`;
}
