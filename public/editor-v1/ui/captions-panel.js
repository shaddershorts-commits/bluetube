// editor-v1/ui/captions-panel.js
// Painel de MODELOS DE LEGENDA no formato pedido em 29/07 (print do CapCut):
// categorias na lateral, busca, favoritos e PREVIA SO NO HOVER.
//
// Mesmo desenho do painel de Transicoes (que o usuario aprovou), de proposito:
// dois painies que fazem a mesma coisa devem se parecer. A miniatura e o
// proprio estilo escrito com a fonte/cor/tarja do modelo; a animacao dele so
// roda quando o mouse passa por cima — grade parada nao distrai, e o hover
// mostra exatamente o que vai acontecer com a legenda.

import {
  CAT_LEGENDA, daCategoriaLegenda, buscarLegenda,
  lerFavoritosLegenda, alternarFavoritoLegenda,
} from '../core/caption-styles.js';

export function createCaptionsPanel(root, { onEscolher, getEscolhido }) {
  const elCats = root.querySelector('#beCapCats');
  const elGrade = root.querySelector('#beCapGrade');
  const elBusca = root.querySelector('#beCapBusca');
  if (!elCats || !elGrade) return { destroy() {}, render() {} };

  let catAtual = 'classicos';
  let favoritos = lerFavoritosLegenda();

  function renderCats() {
    elCats.innerHTML = '';
    for (const c of CAT_LEGENDA) {
      const b = document.createElement('button');
      b.className = 'be-cap-cat' + (c.id === catAtual ? ' active' : '');
      b.textContent = c.nome;
      b.dataset.cat = c.id;
      if (c.id === 'favoritos') b.classList.add('fav');
      elCats.appendChild(b);
    }
  }

  function renderGrade() {
    const termo = elBusca?.value || '';
    const achados = buscarLegenda(termo);
    const lista = achados !== null ? achados : daCategoriaLegenda(catAtual, favoritos);
    const escolhido = getEscolhido?.();
    elGrade.innerHTML = '';

    if (!lista.length) {
      const vazio = document.createElement('div');
      vazio.className = 'be-dim be-cap-vazio';
      vazio.textContent = catAtual === 'favoritos' && achados === null
        ? 'Nenhum favorito ainda. Toque na ★ de um modelo pra guardar aqui.'
        : 'Nada encontrado.';
      elGrade.appendChild(vazio);
      return;
    }

    for (const m of lista) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'be-cap-modelo' + (m.id === escolhido ? ' active' : '') + ' anim-' + (m.anim || 'nenhuma');
      card.dataset.modelo = m.id;
      card.title = m.dica ? `${m.nome} — ${m.dica}` : m.nome;

      const mini = document.createElement('span');
      mini.className = 'be-cap-mini';
      mini.style.fontFamily = `'${m.font}', 'Anton', Impact, sans-serif`;
      if (m.colorMode === 'rotate') {
        // uma letra por cor da paleta: mostra o giro sem precisar animar
        [...m.nome].forEach((ch, i) => {
          const sp = document.createElement('span');
          sp.textContent = ch;
          sp.style.color = m.palette[i % m.palette.length];
          mini.appendChild(sp);
        });
      } else {
        mini.textContent = m.nome;
        mini.style.color = m.color;
        if (m.box) {
          mini.style.background = m.box;
          mini.style.padding = '1px 6px';
          mini.style.borderRadius = '3px';
        }
      }
      card.appendChild(mini);

      const estrela = document.createElement('span');
      estrela.className = 'be-cap-star' + (favoritos.has(m.id) ? ' on' : '');
      estrela.textContent = '★';
      estrela.title = 'Favoritar';
      card.appendChild(estrela);

      elGrade.appendChild(card);
    }
  }

  function render() { renderCats(); renderGrade(); }

  elCats.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    catAtual = b.dataset.cat;
    if (elBusca) elBusca.value = '';
    render();
  });

  elBusca?.addEventListener('input', renderGrade);

  elGrade.addEventListener('click', (e) => {
    const card = e.target.closest('[data-modelo]');
    if (!card) return;
    if (e.target.closest('.be-cap-star')) {
      // favoritar nao pode escolher o modelo — e outra intencao
      e.stopPropagation();
      favoritos = alternarFavoritoLegenda(card.dataset.modelo);
      renderGrade();
      return;
    }
    onEscolher?.(card.dataset.modelo);
    renderGrade();
  });

  render();
  return { render, destroy() { elGrade.innerHTML = ''; elCats.innerHTML = ''; } };
}
