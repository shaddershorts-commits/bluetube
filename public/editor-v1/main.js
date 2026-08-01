// editor-v1/main.js
// Bootstrap: flag -> gate auth/plano -> restaura projeto -> mount.

import { createStore } from './core/store.js';
import { normalizeLoadedState } from './core/schema.js';
import { bootstrapGate, api, getToken } from './services/api.js';
import { mountEditor } from './ui/shell.js';
import { mountHome } from './ui/home.js';

const root = document.getElementById('beRoot');

function gateScreen(icon, title, msg, ctaHtml = '') {
  root.innerHTML = `
    <div class="be-gate">
      <div class="be-gate-icon">${icon}</div>
      <div class="be-gate-title">${title}</div>
      <div class="be-gate-msg">${msg}</div>
      ${ctaHtml}
    </div>`;
}

async function boot() {
  gateScreen('⏳', 'Carregando BlueEditor…', 'Um instante.');

  const { flag, user } = await bootstrapGate();

  if (!flag?.enabled) {
    gateScreen('🚧', 'Em construção', 'O BlueEditor está recebendo os últimos ajustes. Volta em breve!',
      '<a class="be-export-btn" href="/">Voltar pro início</a>');
    return;
  }
  if (!getToken() || !user) {
    gateScreen('🔒', 'Login necessário', 'Entre na sua conta BlueTube pra usar o editor.',
      '<a class="be-export-btn" href="/?login=1&next=/blueEditor-app">Fazer login</a>');
    return;
  }
  const plan = (user.plan || 'free').toLowerCase();
  if (plan !== 'master' && plan !== 'full') {
    gateScreen('👑', 'Exclusivo Full e Master', 'O BlueEditor faz parte dos planos Full e Master.',
      '<a class="be-export-btn" href="/#planos">Ver planos</a>');
    return;
  }

  // CapCut-like: abre na TELA INICIAL (grid de projetos salvos + "Criar
  // projeto"). Só entra no editor ao escolher um projeto ou criar do zero.
  showHome();
}

// tela inicial ↔ editor
// Guarda o editor montado: trocar de tela sem desmontar deixava o autosave
// assinado escrevendo num DOM que já foi apagado.
let editorAtivo = null;

function showHome() {
  try { editorAtivo?.destroy(); } catch (e) {}
  editorAtivo = null;
  root.innerHTML = '';
  mountHome(root, { onOpen: enterEditor });
}

async function enterEditor(projectId) {
  const store = createStore();
  if (projectId) {
    try {
      const { project } = await api.loadProject(projectId);
      if (project?.project_state) {
        store.replaceState(normalizeLoadedState({ ...project.project_state, project_id: project.id }));
      }
    } catch (e) {
      // NÃO ABRIR VAZIO EM SILÊNCIO (fix 2026-07-29): a falha era só um
      // console.warn e o editor abria em branco — indistinguível de "perdi meu
      // projeto". Com a sessão vencida isso acontecia toda vez que o usuário
      // saía e voltava. Melhor parar e dizer o que houve do que fingir que o
      // projeto está vazio.
      console.warn('[main] load-project falhou:', e.message);
      if (e.sessaoExpirada) {
        gateScreen('🔒', 'Sua sessão expirou',
          'Entre de novo pra continuar de onde parou. Seu projeto está salvo.',
          '<a class="be-export-btn" href="/?login=1&next=/blueEditor-app">Fazer login</a>');
      } else {
        gateScreen('⚠️', 'Não consegui abrir o projeto', e.message || 'Tenta de novo em instantes.',
          '<button class="be-export-btn" onclick="location.reload()">Tentar de novo</button>');
      }
      return;
    }
  }
  try { editorAtivo?.destroy(); } catch (e) {}
  root.innerHTML = '';
  // onExit volta pra tela inicial (autosave já persistiu o projeto)
  try {
    editorAtivo = mountEditor(root, store, { onExit: showHome });
  } catch (e) {
    // ⚠️ REDE DE SEGURANÇA (user 2026-07-29: "qualquer função quebrada
    // compromete MUITO o produto"). Um erro no meio do mount já deixou o
    // editor meio-montado e morto uma vez (o TDZ do attachResizers) — sem
    // isto o usuário via a carcaça sem saber o que houve. O projeto dele
    // está no autosave/servidor; a saída honesta é dizer e oferecer volta.
    console.error('[main] mountEditor falhou:', e);
    gateScreen('⚠️', 'O editor não conseguiu abrir',
      'Deu um erro ao montar a tela. Seu projeto está salvo — nada foi perdido.',
      '<button class="be-export-btn" onclick="location.reload()">Recarregar</button>' +
      '<a class="be-export-btn" style="margin-left:8px" href="/blueEditor-app">Meus projetos</a>');
  }
}

// ── VIGIA GLOBAL ────────────────────────────────────────────────────────────
// Erro engolido é o pior modo de falha: a função morre e o usuário acha que o
// produto "não faz nada". Qualquer exceção não tratada ou promise rejeitada
// vira um aviso visível UMA vez (sem spam), com o erro inteiro no console.
let avisoMostrado = false;
function avisarErroGlobal(e) {
  console.error('[vigia]', e);
  if (avisoMostrado) return;
  avisoMostrado = true;
  setTimeout(() => { avisoMostrado = false; }, 30000);  // no máx 1 aviso / 30s
  const t = document.getElementById('beToast');
  if (t) {
    t.textContent = '⚠️ Algo deu errado nesta ação. Se notar algo estranho, recarregue a página — seu projeto está salvo.';
    t.classList.add('show', 'err');
    setTimeout(() => t.classList.remove('show', 'err'), 6000);
  }
}
window.addEventListener('error', (ev) => avisarErroGlobal(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => avisarErroGlobal(ev.reason));

boot().catch(e => {
  console.error('[main] boot falhou:', e);
  gateScreen('⚠️', 'Erro ao carregar', e.message || 'Tenta recarregar a página.',
    '<button class="be-export-btn" onclick="location.reload()">Recarregar</button>');
});
