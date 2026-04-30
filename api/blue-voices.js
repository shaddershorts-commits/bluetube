// api/blue-voices.js — Vozes customizadas do BlueVoice salvas no Supabase
// com metadados reais de idioma/sotaque/gênero/estilo do ElevenLabs.
//
// DEFESA EM CAMADAS pra classificar idioma de voz importada:
//   Camada 1 — regex em labels/verified_languages (vozes premade Eleven)
//   Camada 2 — dicionario de nomes (vozes clonadas com nome cultural)
//   Camada 3 — lookup extra com_settings=true na Eleven (verified_languages)
//   Camada 4 — manual via dropdown no import (frontend)
//   Camada 5 — bloqueio de save quando todas falham (frontend)
//   Camada 6 — botao "Editar idioma" pra corrigir vozes ja salvas (frontend)
//   Camada 7 — coluna lang_source no DB (rastreia COMO foi classificado)
//   Camada 8 — endpoint count-unclassified pra audit
const { generateSpeech } = require('./_helpers/tts.js');

// ── LANG_LIST: 20 idiomas suportados (id, code, flag, label) ───────────────
// Mantido em sync com dropdown do frontend pra evitar codigo invalido.
const LANG_LIST = [
  { code: 'pt-BR', flag: '🇧🇷', label: 'Português (Brasil)' },
  { code: 'pt-PT', flag: '🇵🇹', label: 'Português (Portugal)' },
  { code: 'en-US', flag: '🇺🇸', label: 'English (US)' },
  { code: 'en-GB', flag: '🇬🇧', label: 'English (UK)' },
  { code: 'en-AU', flag: '🇦🇺', label: 'English (AU)' },
  { code: 'es-ES', flag: '🇪🇸', label: 'Español (España)' },
  { code: 'es-MX', flag: '🇲🇽', label: 'Español (México)' },
  { code: 'fr-FR', flag: '🇫🇷', label: 'Français' },
  { code: 'de-DE', flag: '🇩🇪', label: 'Deutsch' },
  { code: 'it-IT', flag: '🇮🇹', label: 'Italiano' },
  { code: 'ja-JP', flag: '🇯🇵', label: '日本語' },
  { code: 'ko-KR', flag: '🇰🇷', label: '한국어' },
  { code: 'zh-CN', flag: '🇨🇳', label: '中文' },
  { code: 'ar',    flag: '🇸🇦', label: 'العربية' },
  { code: 'hi',    flag: '🇮🇳', label: 'हिन्दी' },
  { code: 'tr',    flag: '🇹🇷', label: 'Türkçe' },
  { code: 'id',    flag: '🇮🇩', label: 'Bahasa Indonesia' },
  { code: 'nl-NL', flag: '🇳🇱', label: 'Nederlands' },
  { code: 'ru-RU', flag: '🇷🇺', label: 'Русский' },
  { code: 'pl-PL', flag: '🇵🇱', label: 'Polski' },
];
const LANG_BY_CODE = Object.fromEntries(LANG_LIST.map(l => [l.code, l]));

// ── HELPERS DE NORMALIZAÇÃO DE METADADOS ELEVENLABS ─────────────────────────
const LANG_MAP = [
  // [matcher (lowercase substring ou regex), code, flag, label]
  [/pt[-_]?br|brazilian|brasil|portuguese \(brazil\)/, 'pt-BR', '🇧🇷', 'Português (Brasil)'],
  [/pt[-_]?pt|european portuguese|portuguese \(portugal\)/, 'pt-PT', '🇵🇹', 'Português (Portugal)'],
  [/^portugu|portuguese/, 'pt-BR', '🇧🇷', 'Português (Brasil)'],
  [/en[-_]?gb|british|england/, 'en-GB', '🇬🇧', 'English (UK)'],
  [/en[-_]?us|american english|american|en-us/, 'en-US', '🇺🇸', 'English (US)'],
  [/australian/, 'en-AU', '🇦🇺', 'English (AU)'],
  [/^english/, 'en-US', '🇺🇸', 'English (US)'],
  [/es[-_]?mx|mexican|méxico|mexico/, 'es-MX', '🇲🇽', 'Español (México)'],
  [/es[-_]?es|castilian|spanish \(spain\)/, 'es-ES', '🇪🇸', 'Español (España)'],
  [/^spanish|español|espanhol/, 'es-ES', '🇪🇸', 'Español'],
  [/fr[-_]?fr|french|français|france/, 'fr-FR', '🇫🇷', 'Français'],
  [/de[-_]?de|german|deutsch|germany/, 'de-DE', '🇩🇪', 'Deutsch'],
  [/it[-_]?it|italian|italiano|italy/, 'it-IT', '🇮🇹', 'Italiano'],
  [/ja[-_]?jp|japanese|japan|日本/, 'ja-JP', '🇯🇵', '日本語'],
  [/ko[-_]?kr|korean|korea|한국/, 'ko-KR', '🇰🇷', '한국어'],
  [/zh[-_]?cn|mandarin|chinese|中文|中国/, 'zh-CN', '🇨🇳', '中文'],
  [/arabic|العربية/, 'ar', '🇸🇦', 'العربية'],
  [/hindi|हिन्दी/, 'hi', '🇮🇳', 'हिन्दी'],
  [/turkish|türkçe/, 'tr', '🇹🇷', 'Türkçe'],
  [/indonesian|bahasa/, 'id', '🇮🇩', 'Bahasa Indonesia'],
  [/dutch|nederlands|holand/, 'nl-NL', '🇳🇱', 'Nederlands'],
  [/russian|русск/, 'ru-RU', '🇷🇺', 'Русский'],
  [/polish|polski|polonês/, 'pl-PL', '🇵🇱', 'Polski'],
];

// ── CAMADA 2: dicionario de nomes -> idioma (lowercase, sem acento) ────────
// Quando regex em labels falha, tenta inferir pelo PRIMEIRO nome da voz.
// Cobertura aprox: nomes mais comuns por cultura. Falsos positivos sao OK
// porque user pode editar via Camada 6.
const NAME_TO_LANG = (() => {
  const map = {};
  const add = (code, names) => names.forEach(n => { map[n.toLowerCase()] = code; });
  add('pt-BR', ['andre', 'andré', 'antonio', 'antônio', 'arthur', 'bruno', 'caio', 'davi', 'diego', 'eduardo',
    'fabio', 'fabrício', 'felipe', 'fernando', 'gabriel', 'guilherme', 'gustavo', 'henrique', 'joão', 'jose',
    'josé', 'julio', 'leandro', 'leonardo', 'lucas', 'luiz', 'marcos', 'matheus', 'mateus', 'paulo', 'pedro',
    'rafael', 'ricardo', 'rodrigo', 'thiago', 'tiago', 'vinicius', 'vitor', 'victor', 'kaique', 'kayky',
    'beatriz', 'camila', 'cristina', 'fernanda', 'gabriela', 'isabela', 'juliana', 'larissa', 'leticia',
    'luana', 'mariana', 'paula', 'vitoria']);
  add('en-US', ['adam', 'andrew', 'anthony', 'brian', 'charles', 'charlie', 'chris', 'christopher', 'edward',
    'eric', 'frank', 'george', 'henry', 'jack', 'james', 'jason', 'jeffrey', 'jeremy', 'john', 'jonathan',
    'joseph', 'joshua', 'justin', 'kevin', 'kyle', 'mark', 'matthew', 'michael', 'nicholas', 'noah',
    'oliver', 'patrick', 'paul', 'peter', 'richard', 'robert', 'ryan', 'samuel', 'scott', 'sean',
    'stephen', 'thomas', 'timothy', 'tom', 'tyler', 'william', 'abigail', 'amanda', 'amy', 'ashley',
    'brittany', 'carol', 'catherine', 'chloe', 'claire', 'diana', 'dorothy', 'elizabeth', 'emily', 'emma',
    'grace', 'hannah', 'isabella', 'jane', 'jennifer', 'jessica', 'kate', 'laura', 'lily', 'lisa', 'lucy',
    'madison', 'megan', 'michelle', 'nancy', 'olivia', 'patricia', 'rebecca', 'sarah', 'sophia', 'susan',
    'victoria']);
  add('de-DE', ['hans', 'klaus', 'jürgen', 'jurgen', 'fritz', 'helmut', 'dieter', 'gerhard', 'manfred',
    'rüdiger', 'jens', 'bernd', 'holger', 'otto', 'wolfgang', 'ulrich', 'brigitte', 'ursula', 'gisela',
    'ingrid', 'monika', 'helga', 'renate', 'elke', 'sabine']);
  add('es-ES', ['alejandro', 'alvaro', 'álvaro', 'javier', 'jorge', 'manuel', 'pablo', 'raul', 'raúl',
    'sergio', 'andres', 'andrés', 'carmen', 'pilar']);
  add('fr-FR', ['alain', 'alexandre', 'antoine', 'arnaud', 'benoit', 'benoît', 'christophe', 'didier',
    'étienne', 'francois', 'françois', 'gerard', 'gérard', 'henri', 'jean', 'jacques', 'jérôme', 'jerome',
    'julien', 'laurent', 'louis', 'marc', 'michel', 'olivier', 'philippe', 'pierre', 'raphael', 'raphaël',
    'sebastien', 'sébastien', 'vincent', 'yves', 'agnès', 'cécile', 'céline', 'isabelle', 'jacqueline',
    'monique', 'nathalie', 'sandrine', 'sophie', 'sylvie', 'valérie', 'virginie']);
  add('it-IT', ['alessandro', 'alessio', 'andrea', 'carlo', 'claudio', 'daniele', 'davide', 'emanuele',
    'enrico', 'federico', 'francesco', 'franco', 'gabriele', 'giacomo', 'giorgio', 'giovanni', 'giulio',
    'giuseppe', 'lorenzo', 'luigi', 'mario', 'massimo', 'matteo', 'michele', 'paolo', 'riccardo', 'sergio',
    'stefano', 'tommaso', 'vincenzo', 'alessia', 'antonella', 'barbara', 'beatrice', 'bianca', 'chiara',
    'donatella', 'elisa', 'francesca', 'giulia', 'lucia', 'manuela', 'mariella', 'paola', 'rita', 'roberta',
    'silvia', 'simona', 'sonia', 'valentina', 'valeria']);
  add('ru-RU', ['alexei', 'alexey', 'anatoly', 'andrei', 'arkady', 'artyom', 'boris', 'dmitri', 'dmitry',
    'dimitri', 'evgeny', 'fyodor', 'gennady', 'georgy', 'grigory', 'igor', 'ilya', 'ivan', 'kirill',
    'konstantin', 'leonid', 'maksim', 'maxim', 'mikhail', 'nikita', 'nikolai', 'oleg', 'pavel', 'pyotr',
    'roman', 'ruslan', 'sergei', 'sergey', 'stanislav', 'vadim', 'valery', 'vasily', 'viktor', 'vladimir',
    'vyacheslav', 'yuri', 'yury', 'sasha', 'alyona', 'anastasia', 'ekaterina', 'irina', 'katya', 'larisa',
    'ludmila', 'masha', 'nadezhda', 'natalia', 'natasha', 'olga', 'polina', 'svetlana', 'tatiana', 'yelena']);
  add('ja-JP', ['akira', 'daichi', 'daisuke', 'hayato', 'hideki', 'hiroki', 'hiroshi', 'kaito', 'kenji',
    'koji', 'makoto', 'masaru', 'masato', 'naoki', 'ren', 'riku', 'ryota', 'satoshi', 'sho', 'sora',
    'takashi', 'taro', 'tatsuya', 'yamato', 'yuki', 'yuta', 'yuto', 'aiko', 'akari', 'asuka', 'ayaka',
    'haruka', 'hina', 'kaori', 'kasumi', 'mariko', 'naomi', 'rin', 'sakura', 'sayuri', 'yuko']);
  add('ko-KR', ['junho', 'jisoo', 'jin', 'jinwoo', 'joon', 'jung', 'minho', 'minjun', 'seojun', 'seungho',
    'sungmin', 'woojin', 'youngjae', 'jiyeon', 'sora', 'sumin', 'yejin', 'yuna']);
  add('zh-CN', ['bao', 'biao', 'chen', 'chunhua', 'fang', 'feng', 'huan', 'jing', 'lihua', 'ming', 'qiang',
    'tao', 'wei', 'xiang', 'xiao', 'yang', 'ying', 'zhen', 'zhong']);
  add('ar', ['abdul', 'abdullah', 'ahmad', 'ahmed', 'amir', 'fadi', 'faisal', 'fares', 'hamza', 'hassan',
    'hussein', 'ibrahim', 'ismail', 'kamal', 'karim', 'khaled', 'mahmoud', 'mohamed', 'mohammed',
    'mostafa', 'omar', 'osama', 'rashid', 'salah', 'samir', 'tariq', 'walid', 'yousef', 'youssef',
    'yusuf', 'aisha', 'amal', 'amira', 'fatima', 'hala', 'layla', 'leila', 'mariam', 'maryam',
    'nour', 'rania', 'yasmin', 'zainab']);
  add('hi', ['amit', 'anil', 'arjun', 'arun', 'ashok', 'deepak', 'gaurav', 'kabir', 'krishna', 'kumar',
    'manoj', 'mohan', 'nikhil', 'pranav', 'prashant', 'raj', 'rajesh', 'rakesh', 'ravi', 'rohit',
    'sandeep', 'sanjay', 'shyam', 'sumit', 'sunil', 'suresh', 'vijay', 'vikram', 'vinod', 'vivek',
    'aarti', 'aditi', 'ananya', 'archana', 'asha', 'deepika', 'divya', 'kavita', 'lakshmi', 'meena',
    'megha', 'neha', 'nisha', 'pooja', 'preeti', 'priya', 'priyanka', 'radha', 'rashmi', 'rekha',
    'shilpa', 'shreya', 'simran', 'sita', 'sneha', 'sonia']);
  add('tr', ['ahmet', 'baran', 'burak', 'cem', 'emir', 'emre', 'ercan', 'fatih', 'hakan', 'halil', 'hasan',
    'hüseyin', 'huseyin', 'kaan', 'kadir', 'kemal', 'mehmet', 'murat', 'mustafa', 'oguz', 'oğuz',
    'omer', 'ömer', 'onur', 'orhan', 'recep', 'selim', 'serdar', 'tarik', 'tarık', 'yasin', 'zeki',
    'ayla', 'ayse', 'ayşe', 'beyza', 'ceren', 'ebru', 'elif', 'esra', 'fatma', 'gizem', 'hülya',
    'leyla', 'merve', 'pelin', 'sinem', 'yasemin', 'zehra', 'zeynep']);
  add('id', ['adi', 'andi', 'ari', 'arif', 'bagas', 'bambang', 'budi', 'dani', 'dedi', 'dimas', 'eko',
    'fadli', 'fajar', 'gilang', 'hadi', 'hendra', 'indra', 'joko', 'made', 'nugroho', 'putra', 'rahman',
    'rendy', 'rizki', 'satria', 'wahyu', 'wayan', 'yoga', 'yudi', 'ayu', 'citra', 'dewi', 'dian',
    'indah', 'intan', 'lestari', 'mira', 'nur', 'nurul', 'rina', 'sari', 'siti', 'sri', 'yulia', 'yuni']);
  add('nl-NL', ['aart', 'anton', 'bart', 'bram', 'daan', 'dirk', 'frank', 'frans', 'geert', 'gerard',
    'gerrit', 'hans', 'hendrik', 'hugo', 'jaap', 'jacob', 'jan', 'jeroen', 'joris', 'kees', 'lars',
    'lennart', 'leo', 'luuk', 'maarten', 'marcel', 'martijn', 'niels', 'pieter', 'ruud', 'sander',
    'sjoerd', 'stefan', 'sven', 'theo', 'thijs', 'wouter', 'anke', 'brigitte', 'daphne', 'ellen',
    'esther', 'fenna', 'hilde', 'ilse', 'inge', 'irene', 'janneke', 'karin', 'lieke', 'lotte',
    'manon', 'marieke', 'mariska', 'nadine', 'nienke', 'petra', 'sabine', 'sandra', 'sanne', 'sjoukje',
    'suzanne', 'sylvia', 'tessa', 'tineke']);
  add('pl-PL', ['adrian', 'andrzej', 'antoni', 'bartosz', 'dawid', 'dominik', 'filip', 'grzegorz',
    'hubert', 'jakub', 'janusz', 'jaroslaw', 'jerzy', 'kacper', 'kamil', 'karol', 'krystian',
    'krzysztof', 'lukasz', 'łukasz', 'maciej', 'marcin', 'marek', 'mariusz', 'mateusz', 'michal',
    'michał', 'paweł', 'pawel', 'piotr', 'przemyslaw', 'rafal', 'rafał', 'ryszard', 'slawomir',
    'stanisław', 'szymon', 'tadeusz', 'tomasz', 'wojciech', 'zbigniew', 'agata', 'agnieszka',
    'aleksandra', 'alicja', 'barbara', 'beata', 'bozena', 'danuta', 'dorota', 'edyta', 'ewa', 'halina',
    'hanna', 'irena', 'iwona', 'izabela', 'jadwiga', 'jolanta', 'joanna', 'justyna', 'karolina',
    'katarzyna', 'krystyna', 'magdalena', 'malgorzata', 'marta', 'monika', 'paulina', 'renata',
    'sylwia', 'teresa', 'urszula', 'weronika', 'zofia']);
  return map;
})();

// Camada 2: extrai primeiro token (nome) e procura no dicionario.
function detectByName(voiceName) {
  if (!voiceName || typeof voiceName !== 'string') return null;
  const tokens = voiceName.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[\s\-_]+/);
  for (const t of tokens) {
    if (t && NAME_TO_LANG[t]) return NAME_TO_LANG[t];
  }
  // Tenta tambem o nome inteiro (caso "Mary Jane" -> tenta "mary")
  const firstName = (voiceName.split(/[\s\-_]+/)[0] || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return NAME_TO_LANG[firstName] || null;
}

// Helper: lookup do label/flag a partir do code (pra reaproveitar em Camadas 2/3/4)
function lookupLang(code) {
  if (!code) return { code: null, flag: null, label: null };
  const meta = LANG_BY_CODE[code];
  return meta ? { code, flag: meta.flag, label: meta.label } : { code, flag: null, label: code };
}

// Normaliza labels + verified_languages + nome em metadados padronizados.
// Aplica defesa em camadas 1-2 (Camada 3 fica no caller, que tem acesso a xiKey).
// Retorna meta + lang_source ('auto_labels' | 'auto_name' | null) pra Camada 7.
function normalizeVoice(v) {
  const labels = v.labels || {};
  const verified = Array.isArray(v.verified_languages) ? v.verified_languages : [];
  const hay = [
    labels.accent || '', labels.language || '', labels.description || '',
    labels.use_case || '', v.name || '', v.category || '',
    ...verified.map(x => typeof x === 'string' ? x : (x?.language || x?.locale || ''))
  ].join(' ').toLowerCase();

  let langCode = null, langFlag = null, langLabel = null, langSource = null;

  // ── CAMADA 1: regex em labels/verified_languages ─────────────────────────
  for (const [rx, code, flag, label] of LANG_MAP) {
    if (rx.test(hay)) {
      langCode = code; langFlag = flag; langLabel = label;
      langSource = 'auto_labels';
      break;
    }
  }

  // ── CAMADA 2: dicionario de nomes (se Camada 1 falhou) ───────────────────
  if (!langCode) {
    const codeFromName = detectByName(v.name);
    if (codeFromName) {
      const meta = lookupLang(codeFromName);
      langCode = meta.code; langFlag = meta.flag; langLabel = meta.label;
      langSource = 'auto_name';
    }
  }

  // Gênero
  const g = (labels.gender || '').toLowerCase();
  const genero = g.includes('female') || g.includes('fem') ? 'Feminino'
              : g.includes('male') || g.includes('masc') ? 'Masculino'
              : '';

  // Idade
  const a = (labels.age || '').toLowerCase();
  const idade = a.includes('young') ? 'Jovem'
             : a.includes('middle') ? 'Adulto'
             : a.includes('old') ? 'Sênior'
             : '';

  // Estilo (use_case + description)
  const style = `${labels.use_case || ''} ${labels.description || ''}`.toLowerCase();
  const estilo = style.includes('narrat') ? 'Narração'
              : style.includes('conversation') || style.includes('casual') ? 'Conversacional'
              : style.includes('news') || style.includes('professional') ? 'Profissional'
              : style.includes('dramatic') || style.includes('intense') ? 'Dramático'
              : style.includes('young') || style.includes('social') ? 'Jovem'
              : 'Narração';

  // Multilingual: mais de 1 idioma verificado OU use_case/description contém "multilingual"
  const multilingual = verified.length > 1
    || /multiling/.test(style)
    || /multiling/.test(hay);

  return {
    idioma_real: langLabel,
    lang_code: langCode,
    lang_flag: langFlag,
    lang_source: langSource,
    sotaque: labels.accent || '',
    genero,
    idade,
    estilo,
    descricao: labels.description || '',
    multilingual,
    metadata: {
      raw_labels: labels,
      verified_languages: verified,
      category: v.category || '',
      preview_url: v.preview_url || ''
    }
  };
}

async function fetchElevenMetadata(voiceId, xiKey) {
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}?with_settings=false`, {
      headers: { 'xi-api-key': xiKey }
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SU = process.env.SUPABASE_URL;
  const SK = process.env.SUPABASE_SERVICE_KEY;
  const AK = process.env.SUPABASE_ANON_KEY || SK;
  const EL = process.env.ELEVENLABS_API_KEY;
  if (!SU || !SK) return res.status(500).json({ error: 'Config missing' });
  const h = { apikey: SK, Authorization: 'Bearer ' + SK, 'Content-Type': 'application/json' };

  // ── GET ?action=premade-previews — metadata + preview_url dos 20 premade ─
  // + lista curada de community voices (EXTRA_CURATED_VOICE_IDS).
  // Frontend cacheia em localStorage com TTL de 7 dias.
  if (req.method === 'GET' && req.query.action === 'premade-previews') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });

    // Vozes community/shared curadas manualmente (adicionadas pelo admin).
    // Cada ID aqui é buscado via /v1/voices/{id} porque NÃO aparece em /v1/voices.
    const EXTRA_CURATED_VOICE_IDS = [
      'HOfBIVLhom4mc9WvXfyH', // André Lot — PT-BR masculino narração
      '0YziWIrqiRTHCxeg1lyc', // Will — PT-BR masculino energético
    ];

    try {
      // 1) /v1/voices → premade + quaisquer vozes já na conta
      const r = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': EL }
      });
      const allVoices = [];
      const seen = new Set();

      if (r.ok) {
        const data = await r.json();
        (data.voices || [])
          .filter(v => v.category === 'premade' && v.preview_url)
          .forEach(v => {
            if (seen.has(v.voice_id)) return;
            seen.add(v.voice_id);
            allVoices.push({
              id: v.voice_id,
              name: v.name,
              preview_url: v.preview_url,
              labels: v.labels || {},
              verified_languages: v.verified_languages || [],
              high_quality_base_model_ids: v.high_quality_base_model_ids || []
            });
          });
      }

      // 2) Para cada voz community curada, chama /v1/voices/{id} individual
      for (const voiceId of EXTRA_CURATED_VOICE_IDS) {
        if (seen.has(voiceId)) continue;
        try {
          const vr = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
            headers: { 'xi-api-key': EL }
          });
          if (vr.ok) {
            const vd = await vr.json();
            allVoices.push({
              id: vd.voice_id,
              name: vd.name,
              preview_url: vd.preview_url || null,
              labels: vd.labels || {},
              verified_languages: vd.verified_languages || [],
              high_quality_base_model_ids: vd.high_quality_base_model_ids || [],
              curated: true
            });
            seen.add(voiceId);
          }
        } catch (e) { /* skip */ }
      }

      return res.status(200).json({
        voices: allVoices,
        count: allVoices.length,
        ts: Date.now()
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ?action=library — vozes da Shared Library do ElevenLabs ───────────
  if (req.method === 'GET' && req.query.action === 'library') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      const langs = ['pt', 'en', 'es', 'fr', 'de', 'it'];
      const allVoices = [];

      for (const lang of langs) {
        try {
          const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?page_size=10&language=${lang}&sort=trending`, {
            headers: { 'xi-api-key': EL }
          });
          if (!r.ok) continue;
          const data = await r.json();
          (data.voices || []).forEach(v => {
            if (v.preview_url && !allVoices.find(x => x.id === v.voice_id)) {
              const norm = normalizeVoice({
                name: v.name, labels: { accent: v.accent, language: v.language || lang, gender: v.gender, age: v.age, use_case: v.use_case, description: v.description },
                verified_languages: v.verified_languages, category: v.category
              });
              allVoices.push({
                id: v.voice_id, name: v.name, preview_url: v.preview_url,
                labels: { language: lang, gender: v.gender || '', age: v.age || '', use_case: v.use_case || v.category || '', description: v.description || '' },
                category: v.category || '',
                ...norm
              });
            }
          });
        } catch (e) { continue; }
      }

      if (allVoices.length > 0) return res.status(200).json({ voices: allVoices });

      // Fallback: endpoint clássico
      const r2 = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': EL }
      });
      if (r2.ok) {
        const data2 = await r2.json();
        const voices2 = (data2.voices || []).filter(v => v.preview_url).map(v => ({
          id: v.voice_id, name: v.name, preview_url: v.preview_url,
          labels: v.labels || {}, category: v.category || '',
          ...normalizeVoice(v)
        }));
        if (voices2.length > 0) return res.status(200).json({ voices: voices2 });
      }

      return res.status(200).json({ voices: [] });
    } catch (e) {
      console.error('blue-voices library error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  const token = req.method === 'GET' ? req.query.token : req.body?.token;
  if (!token) return res.status(401).json({ error: 'Login necessário' });

  // Valida usuário
  let userId;
  try {
    const uR = await fetch(`${SU}/auth/v1/user`, { headers: { apikey: AK, Authorization: 'Bearer ' + token } });
    if (!uR.ok) return res.status(401).json({ error: 'Token inválido' });
    userId = (await uR.json()).id;
  } catch (e) { return res.status(401).json({ error: 'Token inválido' }); }

  // ── GET ?action=sync-all — re-busca metadados no ElevenLabs e popula DB ───
  if (req.method === 'GET' && req.query.action === 'sync-all') {
    if (!EL) return res.status(500).json({ error: 'ElevenLabs não configurado' });
    try {
      const r = await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&select=voice_id,name,lang_code`, { headers: h });
      const rows = r.ok ? await r.json() : [];
      const results = [];
      for (const row of rows) {
        if (row.lang_code) { results.push({ id: row.voice_id, skipped: true }); continue; }
        const vd = await fetchElevenMetadata(row.voice_id, EL);
        if (!vd) { results.push({ id: row.voice_id, ok: false, reason: 'not found' }); continue; }
        const meta = normalizeVoice(vd);
        const patch = await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&voice_id=eq.${row.voice_id}`, {
          method: 'PATCH',
          headers: { ...h, Prefer: 'return=minimal' },
          body: JSON.stringify(meta)
        });
        results.push({ id: row.voice_id, ok: patch.ok });
      }
      return res.status(200).json({ ok: true, synced: results.length, results });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // GET — lista vozes do usuário + comunidade (com metadados completos)
  if (req.method === 'GET') {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&order=created_at.asc&select=*`,
        { headers: h }
      );
      const myVoices = r.ok ? await r.json() : [];
      const myIds = new Set(myVoices.map(v => v.voice_id));

      let communityVoices = [];
      try {
        const cr = await fetch(
          `${SU}/rest/v1/blue_custom_voices?user_id=neq.${userId}&order=created_at.desc&limit=50&select=*`,
          { headers: h }
        );
        if (cr.ok) {
          const all = await cr.json();
          const seen = new Set();
          communityVoices = all.filter(v => {
            if (myIds.has(v.voice_id) || seen.has(v.voice_id)) return false;
            seen.add(v.voice_id);
            return true;
          }).map(v => ({ ...v, community: true }));
        }
      } catch (e) {}

      return res.status(200).json({ voices: myVoices, community: communityVoices });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // POST — adiciona voz com metadados reais do ElevenLabs.
  // body: { voice_id, name, user_xi_key, lang_override? }
  // lang_override: code valido de LANG_LIST (Camada 4 manual). Se vier, vence
  // qualquer auto-detect e marca lang_source='manual'.
  if (req.method === 'POST') {
    const { voice_id, name, user_xi_key, lang_override } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });

    const finalName = name || 'Voz personalizada';
    const xiKey = user_xi_key || EL;

    let realName = '';
    let previewB64 = '';
    let meta = null;

    if (xiKey) {
      try {
        // ── CAMADA 3: lookup com_settings=true pra puxar verified_languages ─
        // (algumas vozes so retornam esse campo no endpoint completo)
        const vd = await fetchElevenMetadata(voice_id, xiKey);
        if (vd) {
          realName = vd.name || '';
          meta = normalizeVoice(vd);
          // Se Camadas 1+2 nao detectaram, tenta lookup extra ja conta como
          // Camada 3 (verified_languages do mesmo fetch).
          if (!meta.lang_code && Array.isArray(vd.verified_languages) && vd.verified_languages.length) {
            const firstVerified = vd.verified_languages[0];
            const verifiedHay = (typeof firstVerified === 'string' ? firstVerified
              : (firstVerified?.language || firstVerified?.locale || '')).toLowerCase();
            for (const [rx, code, flag, label] of LANG_MAP) {
              if (rx.test(verifiedHay)) {
                meta.lang_code = code; meta.lang_flag = flag; meta.idioma_real = label;
                meta.lang_source = 'auto_eleven';
                break;
              }
            }
          }
          // Preview
          if (vd.preview_url) {
            try {
              const pr = await fetch(vd.preview_url);
              if (pr.ok) previewB64 = Buffer.from(await pr.arrayBuffer()).toString('base64');
            } catch (e) {}
          }
          if (!previewB64) {
            try {
              const { audio } = await generateSpeech('Olá! Essa é uma prévia da minha voz.', voice_id, {
                stability: 0.5,
                similarity: 0.75,
                modelId: 'eleven_multilingual_v2',
              });
              previewB64 = audio.toString('base64');
            } catch (e) { /* preview é opcional */ }
          }
        } else {
          console.log('[blue-voices] Voice not accessible via API:', voice_id);
        }
      } catch (e) { console.log('[blue-voices] Check error:', e.message); }
    }

    // ── CAMADA 4: lang_override manual (vence qualquer auto-detect) ──────
    if (lang_override && LANG_BY_CODE[lang_override]) {
      const m = LANG_BY_CODE[lang_override];
      meta = meta || {};
      meta.lang_code = m.code;
      meta.lang_flag = m.flag;
      meta.idioma_real = m.label;
      meta.lang_source = 'manual';
    }

    // ── CAMADA 5: bloqueio se ainda nao tem lang_code ─────────────────────
    // Frontend recebe needs_manual_language=true e abre dropdown forcado.
    if (!meta || !meta.lang_code) {
      return res.status(200).json({
        ok: false,
        needs_manual_language: true,
        real_name: realName || finalName,
        message: 'Não consegui detectar o idioma. Escolha manualmente.',
      });
    }

    // Salva com metadados reais (upsert)
    try {
      const payload = {
        user_id: userId,
        voice_id,
        name: realName || finalName,
        ...(meta || {})
      };
      const r = await fetch(`${SU}/rest/v1/blue_custom_voices`, {
        method: 'POST',
        headers: { ...h, Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(payload)
      });
      const saved = await r.json();
      return res.status(200).json({
        ok: true,
        voice: Array.isArray(saved) ? saved[0] : saved,
        real_name: realName || finalName,
        meta: meta || null,
        preview: previewB64 || null
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── PATCH ?action=update-lang — Camada 6: editar idioma de voz ja salva ──
  // body: { voice_id, lang_code }
  if (req.method === 'PATCH' && req.query.action === 'update-lang') {
    const { voice_id, lang_code } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });
    if (!lang_code || !LANG_BY_CODE[lang_code]) {
      return res.status(400).json({ error: 'lang_code inválido', valid_codes: Object.keys(LANG_BY_CODE) });
    }
    const m = LANG_BY_CODE[lang_code];
    try {
      const pr = await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&voice_id=eq.${voice_id}`, {
        method: 'PATCH',
        headers: { ...h, Prefer: 'return=minimal' },
        body: JSON.stringify({
          lang_code: m.code,
          lang_flag: m.flag,
          idioma_real: m.label,
          lang_source: 'manual_edit',
        }),
      });
      if (!pr.ok) {
        const txt = await pr.text().catch(() => '');
        return res.status(500).json({ error: 'patch_failed', detail: txt.slice(0, 200) });
      }
      return res.status(200).json({ ok: true, lang_code: m.code, idioma_real: m.label });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // ── GET ?action=count-unclassified — Camada 8: audit/visibility ──────────
  // Conta vozes do user atual com lang_code=null pra Felipe revisar.
  if (req.method === 'GET' && req.query.action === 'count-unclassified') {
    try {
      const r = await fetch(
        `${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&lang_code=is.null&select=voice_id,name,lang_source,created_at`,
        { headers: h }
      );
      const rows = r.ok ? await r.json() : [];
      return res.status(200).json({
        ok: true,
        count: rows.length,
        voices: rows,
      });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { voice_id } = req.body || {};
    if (!voice_id) return res.status(400).json({ error: 'voice_id obrigatório' });
    try {
      await fetch(`${SU}/rest/v1/blue_custom_voices?user_id=eq.${userId}&voice_id=eq.${voice_id}`, {
        method: 'DELETE', headers: h
      });
      return res.status(200).json({ ok: true });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).end();
};
