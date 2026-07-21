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
function showHome() {
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
      console.warn('[main] load-project falhou:', e.message);
    }
  }
  root.innerHTML = '';
  // onExit volta pra tela inicial (autosave já persistiu o projeto)
  mountEditor(root, store, { onExit: showHome });
}

boot().catch(e => {
  console.error('[main] boot falhou:', e);
  gateScreen('⚠️', 'Erro ao carregar', e.message || 'Tenta recarregar a página.',
    '<button class="be-export-btn" onclick="location.reload()">Recarregar</button>');
});
