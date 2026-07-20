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
  let sizes = { propsW: 300, tlH: 190 };
  try { sizes = { ...sizes, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) }; } catch {}
  apply();

  function apply() {
    // tetos PROPORCIONAIS à janela (user: "preciso poder expandir a barra de
    // edição") — antes travava em 420px de timeline / 520px de painel.
    const maxTl = Math.max(420, Math.round(window.innerHeight * 0.72));
    const maxProps = Math.max(520, Math.round(window.innerWidth * 0.42));
    sizes.propsW = Math.min(maxProps, Math.max(220, sizes.propsW));
    sizes.tlH = Math.min(maxTl, Math.max(120, sizes.tlH));
    if (isDesktop()) {
      // inline SO no desktop — no mobile sobrescreveria o media query.
      // col1 = biblioteca de mídia (232px), col2 = config (ajustável), col3 = preview
      ws.style.gridTemplateColumns = `232px ${sizes.propsW}px minmax(0, 1fr)`;
      timelineWrap.style.height = sizes.tlH + 'px';
    } else {
      ws.style.gridTemplateColumns = '';
      timelineWrap.style.height = '';
    }
    onResize?.();
  }
  window.addEventListener('resize', apply);
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(sizes)); } catch {}
  }

  // gutter vertical: entre props e preview
  const gv = document.createElement('div');
  gv.className = 'be-gutter-v';
  ws.appendChild(gv);
  // gutter horizontal: acima da timeline (divisa preview/timeline)
  const gh = document.createElement('div');
  gh.className = 'be-gutter-h';
  timelineWrap.parentElement.insertBefore(gh, timelineWrap);

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
  drag(gv, (s0, dx) => { sizes.propsW = s0.propsW + dx; });
  drag(gh, (s0, _dx, dy) => { sizes.tlH = s0.tlH - dy; });

  return () => { gv.remove(); gh.remove(); };
}
