/* BlueTube Blog — interatividade leve (sem dependências). */
(function(){
  'use strict';

  // ── Copy link (compartilhar) ──────────────────────────────────────
  window.copyPostLink = function(btn){
    var url = window.location.href.split('#')[0];
    var label = btn.innerHTML;
    navigator.clipboard.writeText(url).then(function(){
      btn.classList.add('is-copied');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copiado';
      setTimeout(function(){
        btn.classList.remove('is-copied');
        btn.innerHTML = label;
      }, 1800);
    }).catch(function(){
      btn.innerHTML = 'Erro :(';
      setTimeout(function(){ btn.innerHTML = label; }, 1500);
    });
  };

  // ── TOC active link on scroll ─────────────────────────────────────
  function initTocScrollSpy(){
    var toc = document.querySelector('.blog-toc');
    if(!toc) return;
    var links = toc.querySelectorAll('a[href^="#"]');
    if(!links.length) return;

    var sections = [];
    links.forEach(function(a){
      var id = a.getAttribute('href').slice(1);
      var el = document.getElementById(id);
      if(el) sections.push({ id: id, el: el, link: a });
    });
    if(!sections.length) return;

    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          sections.forEach(function(s){ s.link.classList.remove('is-active'); });
          var hit = sections.find(function(s){ return s.el === entry.target; });
          if(hit) hit.link.classList.add('is-active');
        }
      });
    }, { rootMargin: '-20% 0% -70% 0%', threshold: 0 });

    sections.forEach(function(s){ io.observe(s.el); });
  }

  // ── Reveal on scroll (fade+lift cards / seções) ───────────────────
  function initRevealOnScroll(){
    var targets = document.querySelectorAll('.blog-card, .blog-post-body section, .blog-related-card');
    if(!targets.length || !('IntersectionObserver' in window)) return;

    targets.forEach(function(t){ t.classList.add('reveal'); });

    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 });

    targets.forEach(function(t){ io.observe(t); });
  }

  // ── Smooth scroll pra TOC links (fallback se CSS scroll-behavior falhar) ──
  function initSmoothScroll(){
    document.querySelectorAll('a[href^="#"]').forEach(function(a){
      a.addEventListener('click', function(e){
        var id = a.getAttribute('href').slice(1);
        if(!id) return;
        var el = document.getElementById(id);
        if(!el) return;
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + id);
      });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  function init(){
    try { initTocScrollSpy(); } catch(e){}
    try { initRevealOnScroll(); } catch(e){}
    try { initSmoothScroll(); } catch(e){}
  }
})();
