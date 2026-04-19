// Typewriter effect com velocidade variavel e pausas dramaticas.
// Uso: type(el, 'texto', { speed: 45, onDone: fn }) — retorna Promise.
// Para texto com pausas, use '|' como separador: 'frase 1|frase 2' (pausa 1.2s entre).

(function(){
  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  async function typeInto(el, text, opts){
    opts = opts || {};
    const speed = opts.speed || 45;
    const jitter = opts.jitter != null ? opts.jitter : 30;
    const pausa = opts.pausa || 1200;
    const showCursor = opts.cursor !== false;

    // Limpa e adiciona cursor
    el.innerHTML = '';
    const cur = showCursor ? document.createElement('span') : null;
    if (cur){ cur.className = 'tw-cursor'; el.appendChild(cur); }

    const blocos = text.split('|');
    for (let b = 0; b < blocos.length; b++){
      const bloco = blocos[b];
      for (const ch of bloco){
        if (cur){ cur.insertAdjacentText('beforebegin', ch); }
        else { el.insertAdjacentText('beforeend', ch); }
        await sleep(speed + Math.random() * jitter);
      }
      if (b < blocos.length - 1) await sleep(pausa);
    }

    if (opts.onDone) opts.onDone();
    return el;
  }

  // Expor global
  window.teaserType = typeInto;
})();
