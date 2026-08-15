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
  let sizes = { libW: 232, previewW: 440, tlH: 200 };
  try { sizes = { ...sizes, ...(JSON.parse(localStorage.getItem(LS_KEY)) || {}) }; } catch {}

  // larguras minimas de cada coluna pra ela continuar UTIL
  const MIN_LIB = 170;    // rail dos ícones + nome do arquivo legível
  const MIN_CFG = 250;    // painel de configuração sem quebrar os campos
  const MIN_PREV = 300;   // player em 9:16 ainda enxergável

  function apply() {
    // Tetos PROPORCIONAIS à janela (user pediu VÁRIAS vezes "poder expandir a
    // barra de edição"). A ALTURA da timeline agora é via grid-template-rows
    // (robusto) — antes setava height do .be-timeline-wrap, que tem flex:1 e
    // ignorava. col1 = biblioteca | col2 = config (flexível) | col3 = preview.
    // ENQUADRAMENTO VERTICAL (2026-08-07): a timeline nunca pode espremer a
    // linha de cima abaixo do mínimo útil — a biblioteca tem conteúdo de
    // altura fixa (rail + importar + dica) que NÃO encolhe; sem esta trava o
    // conteúdo dela vazava por cima da timeline (era a "invasão" do user;
    // janela baixa + divisor salvo alto = linha de cima de ~80px).
    const MIN_TOP = 240;
    const csV = getComputedStyle(ws);
    const padY = (parseFloat(csV.paddingTop) || 0) + (parseFloat(csV.paddingBottom) || 0);
    const vaoY = parseFloat(csV.rowGap) || 0;
    // workspace ainda OCULTO no mount mede 0: cai num fallback conservador
    // (janela menos header/margens) — quando ele aparece, o observer abaixo
    // reaplica com a medida real
    const altura = (ws.clientHeight || (window.innerHeight - 120)) - padY - vaoY;
    const maxTl = Math.min(Math.max(420, Math.round(window.innerHeight * 0.78)),
      Math.max(120, altura - MIN_TOP));
    const maxPrev = Math.max(560, Math.round(window.innerWidth * 0.5));
    const maxLib = Math.max(320, Math.round(window.innerWidth * 0.32));
    sizes.libW = Math.min(maxLib, Math.max(MIN_LIB, sizes.libW || 232));
    sizes.previewW = Math.min(maxPrev, Math.max(MIN_PREV, sizes.previewW || 440));
    sizes.tlH = Math.min(maxTl, Math.max(120, sizes.tlH || 200));

    // ENQUADRAMENTO: as duas colunas de largura fixa não podem espremer a do
    // meio até sumir. Em tela estreita (ou depois de arrastar demais) o excesso
    // é devolvido — primeiro do preview, que é quem tem mais folga.
    if (isDesktop()) {
      // o espaço REAL das colunas desconta padding e os vãos entre elas —
      // sem isso a conta sobra ~50px e a coluna do meio fica menor que o mínimo
      const cs = getComputedStyle(ws);
      const vao = parseFloat(cs.columnGap) || 0;
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const disponivel = (ws.clientWidth || window.innerWidth) - padX - vao * 2;
      let excesso = (sizes.libW + sizes.previewW + MIN_CFG) - disponivel;
      if (excesso > 0) {
        const cortePrev = Math.min(excesso, sizes.previewW - MIN_PREV);
        sizes.previewW -= cortePrev;
        excesso -= cortePrev;
        if (excesso > 0) sizes.libW = Math.max(MIN_LIB, sizes.libW - excesso);
      }
      ws.style.gridTemplateColumns = `${sizes.libW}px minmax(0, 1fr) ${sizes.previewW}px`;
      ws.style.gridTemplateRows = `minmax(0, 1fr) ${sizes.tlH}px`;
    } else {
      ws.style.gridTemplateColumns = '';
      ws.style.gridTemplateRows = '';
    }
    onResize?.();
  }
  apply();
  window.addEventListener('resize', apply);
  // o workspace nasce display:none (home na frente): quando ele aparece de
  // verdade, reaplica com o clientHeight REAL — o clamp da timeline depende
  // da medida certa pra não espremer a linha de cima
  const vis = new IntersectionObserver((es) => { if (es.some(e => e.isIntersecting)) apply(); });
  vis.observe(ws);
  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(sizes)); } catch {}
  }

  // gutter da BIBLIOTECA: entre o painel de ferramentas (Mídia/Texto/Áudio) e
  // o de configurações. Era a única divisa que faltava — a coluna 1 vivia
  // travada em 232px (pedido do user 2026-07-29).
  const gl = document.createElement('div');
  gl.className = 'be-gutter-lib';
  gl.title = 'Arraste pra ajustar a largura do painel de ferramentas';
  ws.appendChild(gl);
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
  drag(gl, (s0, dx) => { sizes.libW = s0.libW + dx; });         // arrasta ➡ = ferramentas mais largo
  drag(gv, (s0, dx) => { sizes.previewW = s0.previewW - dx; }); // arrasta ⬅ = preview mais largo
  drag(gh, (s0, _dx, dy) => { sizes.tlH = s0.tlH - dy; });      // arrasta ⬆ = timeline mais alta

  return () => { gl.remove(); gv.remove(); gh.remove(); };
}
