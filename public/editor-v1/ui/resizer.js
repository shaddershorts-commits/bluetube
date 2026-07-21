// editor-v1/ui/resizer.js
// Divisores arrastaveis estilo CapCut: segura na divisa e ajusta o tamanho
// dos paineis (largura do painel de props e altura da timeline).
// Tamanhos persistem em localStorage.

const LS_KEY = 'be_v1_panel_sizes';

export function attachResizers(root, onResize) {
  const ws = root.querySelector('#beWorkspace');
  const timelineWrap = root.querySelector('.be-timeline-wrap');
  if (!ws || !timelineWrap) return () => {};

  const isDesktop = () => window.matchMedia('(min-width: 861px)').matches;

  // restaura tamanhos salvos
  let sizes = { previewW: 440, tlH: 200 };
  try { sizes = { ...sizes, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) }; } catch {}

  function apply() {
    // Tetos PROPORCIONAIS à janela (user pediu VÁRIAS vezes "poder expandir a
    // barra de edição"). A ALTURA da timeline agora é via grid-template-rows
    // (robusto) — antes setava height do .be-timeline-wrap, que tem flex:1 e
    // ignorava. col1 = biblioteca (232) | col2 = config (flexível) | col3 = preview.
    const maxTl = Math.max(420, Math.round(window.innerHeight * 0.78));
    const maxPrev = Math.max(560, Math.round(window.innerWidth * 0.5));
    sizes.previewW = Math.min(maxPrev, Math.max(300, sizes.previewW || 440));
    sizes.tlH = Math.min(maxTl, Math.max(120, sizes.tlH || 200));
    if (isDesktop()) {
      ws.style.gridTemplateColumns = `232px minmax(0, 1fr) ${sizes.previewW}px`;
      ws.style.gridTemplateRows = `minmax(0, 1fr) ${sizes.tlH}px`;
    } else {
      ws.style.gridTemplateColumns = '';
      ws.style.gridTemplateRows = '';
    }
    onResize?.();
  }
  apply();
  window.addEventListener('resize', apply);
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(sizes)); } catch {}
  }

  // gutter vertical: entre props e preview
  const gv = document.createElement('div');
  gv.className = 'be-gutter-v';
  ws.appendChild(gv);
  // gutter horizontal: no TOPO da área da timeline = a divisa arrastável entre
  // os painéis de cima e a timeline (arrasta ⬆ = timeline maior).
  const gh = document.createElement('div');
  gh.className = 'be-gutter-h';
  const tlArea = timelineWrap.closest('.be-timeline-area') || timelineWrap.parentElement;
  tlArea.insertBefore(gh, tlArea.firstChild);

  function drag(el, onMove) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const x0 = e.clientX, y0 = e.clientY;
      const s0 = { ...sizes };
      const move = (ev) => { onMove(s0, ev.clientX - x0, ev.clientY - y0); apply(); };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        save();
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }
  drag(gv, (s0, dx) => { sizes.previewW = s0.previewW - dx; }); // arrasta ⬅ = preview mais largo
  drag(gh, (s0, _dx, dy) => { sizes.tlH = s0.tlH - dy; });      // arrasta ⬆ = timeline mais alta

  return () => { gv.remove(); gh.remove(); };
}
