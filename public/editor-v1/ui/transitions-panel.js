// editor-v1/ui/transitions-panel.js
// A aba de Transições (2026-07-29) — layout do CapCut: categorias à esquerda,
// grade com prévia à direita, busca em cima, estrelinha de favoritos.
//
// Interação, como o user pediu:
//   • clique 1x  → PRÉVIA no player (não aplica nada)
//   • arrastar   → solta na emenda de duas cenas pra aplicar
//   • ★          → favorita (fica no navegador, acompanha entre projetos)
//
// A miniatura de cada card é uma animação em CSS do próprio efeito, em loop
// no hover. Não é vídeo nem gif: são duas camadas com transform/opacity, que a
// GPU compõe sozinha — 18 cards animando ao mesmo tempo sem custo de CPU.

import { CATEGORIAS, TRANSICOES, daCategoria, buscar, lerFavoritos, alternarFavorito } from '../core/transitions.js';

export function createTransitionsPanel(root, { onPreview, onDragStart }) {
  const elCats = root.querySelector('#beTransCats');
  const elGrade = root.querySelector('#beTransGrade');
  const elBusca = root.querySelector('#beTransBusca');
  if (!elCats || !elGrade) return { destroy() {}, render() {} };

  let catAtual = 'basico';
  let favoritos = lerFavoritos();

  function renderCats() {
    elCats.innerHTML = '';
    for (const c of CATEGORIAS) {
      const b = document.createElement('button');
      b.className = 'be-trans-cat' + (c.id === catAtual ? ' active' : '');
      b.textContent = c.nome;
      b.dataset.cat = c.id;
      if (c.id === 'favoritos') b.classList.add('fav');
      elCats.appendChild(b);
    }
  }

  function renderGrade() {
    const termo = elBusca?.value || '';
    const achados = buscar(termo);
    const lista = achados !== null ? achados : daCategoria(catAtual, favoritos);
    elGrade.innerHTML = '';

    if (!lista.length) {
      const vazio = document.createElement('div');
      vazio.className = 'be-dim be-trans-vazio';
      vazio.textContent = catAtual === 'favoritos' && achados === null
        ? 'Nenhuma favorita ainda. Toque na ★ de uma transição pra guardar aqui.'
        : 'Nada encontrado.';
      elGrade.appendChild(vazio);
      return;
    }

    for (const t of lista) {
      const card = document.createElement('div');
      card.className = 'be-trans-card';
      card.draggable = true;
      card.dataset.trans = t.id;
      card.title = t.nome + ' — clique pra prever, arraste até a emenda pra aplicar';
      // a miniatura ANIMA o próprio efeito (classe por tipo de preview)
      card.innerHTML =
        '<div class="be-trans-mini be-fx-' + t.preview + '">' +
          '<span class="be-trans-a"></span><span class="be-trans-b"></span>' +
        '</div>' +
        '<button class="be-trans-star' + (favoritos.has(t.id) ? ' on' : '') + '" title="Favoritar">★</button>' +
        '<div class="be-trans-nome">' + t.nome + '</div>';
      elGrade.appendChild(card);
    }
  }

  function render() { renderCats(); renderGrade(); }

  // ── eventos ───────────────────────────────────────────────────────────────
  elCats.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    catAtual = b.dataset.cat;
    if (elBusca) elBusca.value = '';
    render();
  });

  elBusca?.addEventListener('input', renderGrade);

  elGrade.addEventListener('click', (e) => {
    const star = e.target.closest('.be-trans-star');
    const card = e.target.closest('[data-trans]');
    if (!card) return;
    if (star) {
      // favoritar não pode disparar prévia — é outra intenção
      e.stopPropagation();
      favoritos = alternarFavorito(card.dataset.trans);
      renderGrade();
      return;
    }
    onPreview?.(card.dataset.trans);
  });

  elGrade.addEventListener('dragstart', (e) => {
    const card = e.target.closest('[data-trans]'); if (!card) return;
    const id = card.dataset.trans;
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/be-transicao', id);
    // alguns navegadores só entregam o payload em text/plain
    e.dataTransfer.setData('text/plain', 'be-transicao:' + id);
    onDragStart?.(id);
  });

  render();
  return { render, destroy() { elGrade.innerHTML = ''; elCats.innerHTML = ''; } };
}
