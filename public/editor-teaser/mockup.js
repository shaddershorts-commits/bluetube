// Mockup animado do editor — timeline se movendo, playhead, Blublu popup,
// score de viralidade pulsando. Tudo DOM puro pra performance.

(function(){
  const mockup = document.getElementById('mockup');
  if (!mockup) return;

  // Rotacao 3D que segue o mouse sutilmente
  const stage = mockup.parentElement;
  let targetRX = 8, targetRY = -12, curRX = 8, curRY = -12;
  stage.addEventListener('mousemove', (e) => {
    const rect = stage.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    targetRX = 8 + (py - 0.5) * -6;
    targetRY = -12 + (px - 0.5) * 12;
  });
  stage.addEventListener('mouseleave', () => { targetRX = 8; targetRY = -12; });
  function rotTick(){
    curRX += (targetRX - curRX) * 0.08;
    curRY += (targetRY - curRY) * 0.08;
    mockup.style.transform = `rotateX(${curRX.toFixed(2)}deg) rotateY(${curRY.toFixed(2)}deg)`;
    requestAnimationFrame(rotTick);
  }
  rotTick();

  // Playhead que anda ao longo da timeline
  const playhead = document.getElementById('tl-playhead');
  const blublu = document.getElementById('tl-blublu');
  const blubluMsgs = [
    'Corte aqui. Confia.',
    'Muito longo. Corta 3s.',
    'Esse gancho é ouro.',
    'Vira viral fácil.',
  ];
  let phPct = 6;
  let phSpeed = 0.12;
  const blubluPoints = [28, 52, 78];
  let shown = new Set();

  // Score de viralidade pulsando
  const scoreVal = document.getElementById('score-val');
  const scoreFill = document.getElementById('score-fill');
  const scores = [67, 71, 74, 78, 81, 84, 82, 86, 83, 85];
  let scoreIdx = 0;

  function updateScore(){
    const v = scores[scoreIdx % scores.length];
    if (scoreVal) scoreVal.textContent = v + '%';
    if (scoreFill) scoreFill.style.width = v + '%';
    scoreIdx++;
  }
  setInterval(updateScore, 2200);
  updateScore();

  function tlTick(){
    phPct += phSpeed;
    if (phPct > 94){ phPct = 6; shown.clear(); if (blublu) blublu.classList.remove('on'); }
    if (playhead) playhead.style.left = phPct + '%';

    // Mostra Blublu em pontos-chave
    for (const pt of blubluPoints){
      if (Math.abs(phPct - pt) < 0.4 && !shown.has(pt)){
        shown.add(pt);
        if (blublu){
          blublu.textContent = blubluMsgs[shown.size % blubluMsgs.length];
          blublu.style.left = phPct + '%';
          blublu.classList.add('on');
          setTimeout(() => blublu.classList.remove('on'), 2200);
        }
      }
    }
    requestAnimationFrame(tlTick);
  }
  requestAnimationFrame(tlTick);

  // Caption que alterna (simula legenda sync)
  const caption = document.getElementById('mockup-caption');
  const caps = [
    'Vou te contar um segredo',
    'Ninguém fala isso',
    'Olha esse número',
    'E agora vem o plot',
  ];
  let cIdx = 0;
  function rotCap(){
    if (caption){
      caption.style.opacity = '0';
      setTimeout(() => {
        caption.textContent = caps[cIdx % caps.length];
        caption.style.opacity = '1';
        cIdx++;
      }, 250);
    }
  }
  setInterval(rotCap, 2800);
})();
