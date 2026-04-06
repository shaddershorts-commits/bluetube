// api/helpers/fallback-roteiros.js — Emergency fallback scripts when AI is down

const FALLBACKS = {
  'Português (Brasil)': [
    'Você não vai acreditar no que aconteceu. Uma história que parece ficção mas é real. Tudo começou quando alguém decidiu fazer diferente. O resultado? Algo que ninguém esperava. E a parte mais louca? Ainda não acabou.',
    'Para de scrollar. Isso aqui é sério. O que eu vou te contar agora pode mudar completamente a forma como você pensa. Presta atenção. Porque depois que você souber disso, não tem como voltar atrás.',
    'Todo mundo disse que era impossível. Que não tinha como dar certo. Mas uma pessoa resolveu provar o contrário. E o que ela fez deixou todo mundo de queixo caído. Assiste até o final que você vai entender porquê.',
  ],
  'English': [
    "You won't believe what just happened. A story that sounds like fiction but it's 100% real. It all started when someone decided to do things differently. The result? Something nobody expected. And the craziest part? It's not over yet.",
    "Stop scrolling. This is serious. What I'm about to tell you could completely change the way you think. Pay attention. Because once you know this, there's no going back.",
    "Everyone said it was impossible. That there was no way it could work. But one person decided to prove them all wrong. And what they did left everyone speechless. Watch until the end and you'll understand why.",
  ],
  'Español': [
    'No vas a creer lo que acaba de pasar. Una historia que parece ficción pero es 100% real. Todo empezó cuando alguien decidió hacer las cosas diferente. ¿El resultado? Algo que nadie esperaba.',
    'Deja de hacer scroll. Esto va en serio. Lo que te voy a contar ahora puede cambiar completamente tu forma de pensar. Presta atención. Porque después de saber esto, no hay vuelta atrás.',
    'Todos dijeron que era imposible. Que no había forma de que funcionara. Pero una persona decidió demostrar lo contrario. Y lo que hizo dejó a todos con la boca abierta.',
  ],
};

function getFallback(lang, version) {
  const scripts = FALLBACKS[lang] || FALLBACKS['Português (Brasil)'];
  const idx = version === 'V2' ? 1 : 0;
  return scripts[idx] || scripts[0];
}

module.exports = { getFallback, FALLBACKS };
