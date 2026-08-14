// editor-v1/ui/home.js
// Tela inicial estilo CapCut: "Criar projeto" (do zero) + grid dos projetos
// salvos automaticamente (autosave). Cada card tem menu (Carregar/Renomear/
// Excluir). onOpen(null) = novo projeto; onOpen(id) = continuar salvo.

import { api } from '../services/api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mountHome(root, { onOpen }) {
  root.innerHTML = `
    <div class="be-home">
      <header class="be-home-head">
        <span class="be-logo">Blue<b>Editor</b></span>
        <a class="be-home-exit" href="/">← Voltar ao BlueTube</a>
      </header>
      <!-- lançamento 14/08: aviso honesto de primeira versão (dismissível) -->
      <div class="be-home-aviso" id="beHomeAviso" style="display:none">
        <span>🎬 <b>Primeira versão do BlueEditor!</b> Melhorias chegando toda semana — achou algo estranho? Conta pra gente no suporte.</span>
        <button type="button" id="beHomeAvisoX" title="Entendi">✕</button>
      </div>
      <div class="be-home-create-row">
        <button class="be-home-create" id="beHomeCreate">
          <span class="be-home-create-ico">＋</span>
          <span class="be-home-create-txt">Criar projeto<small>Começar do zero</small></span>
        </button>
        <button class="be-criar-ia-btn" id="beHomeCriarIA" title="O Blublu monta teu vídeo do início ao fim">
          <span class="be-criar-ia-ico">✨</span>
          <span class="be-criar-ia-txt">Criar com IA<small>O Blublu edita pra você</small></span>
        </button>
      </div>
      <div class="be-home-sub">Seus projetos</div>
      <div class="be-home-grid" id="beHomeGrid">
        <div class="be-home-empty">Carregando…</div>
      </div>
    </div>`;

  root.querySelector('#beHomeCreate').addEventListener('click', () => onOpen(null));

  // CRIAR COM IA (2026-08-13): experiência guiada pelo Blublu. Import
  // dinâmico — quem não clica não paga o peso do módulo.
  // aviso de 1ª versão: some pra sempre depois do ✕
  try {
    if (!localStorage.getItem('be_v1_aviso_lancamento')) {
      root.querySelector('#beHomeAviso').style.display = 'flex';
    }
  } catch {}
  root.querySelector('#beHomeAvisoX').addEventListener('click', () => {
    root.querySelector('#beHomeAviso').style.display = 'none';
    try { localStorage.setItem('be_v1_aviso_lancamento', '1'); } catch {}
  });
  root.querySelector('#beHomeCriarIA').addEventListener('click', async () => {
    const { mountCriarIA } = await import('./criar-ia.js');
    mountCriarIA({ onExit: () => {} });
  });

  async function refresh() {
    const grid = root.querySelector('#beHomeGrid');
    if (!grid) return;
    let projects = [];
    try { ({ projects = [] } = await api.listProjects()); }
    catch { grid.innerHTML = '<div class="be-home-empty">Não consegui carregar seus projetos. Tente recarregar.</div>'; return; }
    if (!projects.length) {
      grid.innerHTML = '<div class="be-home-empty">Nenhum projeto ainda. Clique em <b>Criar projeto</b> pra começar.</div>';
      return;
    }
    grid.innerHTML = '';
    for (const p of projects) grid.appendChild(card(p));
  }

  function card(p) {
    const el = document.createElement('div');
    el.className = 'be-home-card';
    const name = p.nome_projeto || 'Sem título';
    const date = p.updated_at ? new Date(p.updated_at).toLocaleDateString('pt-BR') : '';
    // thumbnail = primeiro frame do vídeo (media fragment #t=, sem canvas/CORS)
    const thumb = p.video_url
      ? `<video class="be-home-thumb" src="${esc(p.video_url)}#t=0.5" muted preload="metadata" playsinline></video>`
      : `<div class="be-home-thumb be-home-thumb-ph">🎬</div>`;
    el.innerHTML = `
      <div class="be-home-thumb-wrap">
        ${thumb}
        <button class="be-home-dots" title="Opções">⋯</button>
      </div>
      <div class="be-home-card-name" title="${esc(name)}">${esc(name)}</div>
      <div class="be-home-card-date">${esc(date)}</div>`;
    const openIt = (e) => { if (e.target.closest('.be-home-dots')) return; onOpen(p.id); };
    el.querySelector('.be-home-thumb-wrap').addEventListener('click', openIt);
    el.querySelector('.be-home-card-name').addEventListener('click', () => onOpen(p.id));
    el.querySelector('.be-home-dots').addEventListener('click', (e) => {
      e.stopPropagation();
      openCardMenu(e.currentTarget, p);
    });
    return el;
  }

  function closeCardMenu() {
    const m = document.getElementById('beHomeMenu');
    if (m) { m._close?.(); m.remove(); }
  }
  function openCardMenu(anchor, p) {
    closeCardMenu();
    const menu = document.createElement('div');
    menu.className = 'be-home-menu';
    menu.id = 'beHomeMenu';
    menu.innerHTML = `
      <button data-act="open">📂 Carregar</button>
      <button data-act="rename">✏️ Renomear</button>
      <button data-act="delete" class="danger">🗑 Excluir</button>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    const mw = 170;
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.querySelector('[data-act="open"]').onclick = () => { closeCardMenu(); onOpen(p.id); };
    menu.querySelector('[data-act="rename"]').onclick = async () => {
      closeCardMenu();
      const novo = prompt('Novo nome do projeto:', p.nome_projeto || '');
      if (novo == null || !novo.trim()) return;
      try { await api.renameProject(p.id, novo.trim()); refresh(); }
      catch (e) { alert('Falha ao renomear: ' + (e.message || e)); }
    };
    menu.querySelector('[data-act="delete"]').onclick = async () => {
      closeCardMenu();
      if (!confirm(`Excluir o projeto "${p.nome_projeto || 'Sem título'}"? Isso não pode ser desfeito.`)) return;
      try { await api.deleteProject(p.id); refresh(); }
      catch (e) { alert('Falha ao excluir: ' + (e.message || e)); }
    };
    setTimeout(() => {
      const close = (ev) => { if (!menu.contains(ev.target)) closeCardMenu(); };
      window.addEventListener('pointerdown', close, true);
      menu._close = () => window.removeEventListener('pointerdown', close, true);
    }, 0);
  }

  refresh();
}
