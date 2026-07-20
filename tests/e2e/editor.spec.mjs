// tests/e2e/editor.spec.mjs — smoke E2E do BlueEditor v1.
// Gestos REAIS de mouse/teclado contra o app rodando — nao e curl 200.
import { test, expect } from '@playwright/test';
import { mockBackend, bootWithVideo, getState, clipRect } from './helpers.mjs';

test.describe('gates @smoke', () => {
  test('flag desligada mostra "Em construção"', async ({ page }) => {
    await page.route('**/api/editor-flag', r => r.fulfill({ json: { enabled: false } }));
    await page.goto('/blueEditor-app');
    await expect(page.locator('.be-gate-title')).toHaveText(/construção/i);
  });

  test('sem login mostra gate de login', async ({ page }) => {
    await page.route('**/api/editor-flag', r => r.fulfill({ json: { enabled: true } }));
    await page.goto('/blueEditor-app');
    await expect(page.locator('.be-gate-title')).toHaveText(/login/i);
  });

  test('plano free bloqueado com upsell', async ({ page }) => {
    await mockBackend(page, { plan: 'free' });
    await page.goto('/blueEditor-app');
    await expect(page.locator('.be-gate-title')).toHaveText(/Full e Master/i);
  });

  test('master passa o gate e ve dropzone', async ({ page }) => {
    await mockBackend(page, { plan: 'master' });
    await page.goto('/blueEditor-app');
    await expect(page.locator('#beDrop')).toBeVisible();
  });
});

test.describe('upload + documento @smoke', () => {
  test('upload popula state.video com duracao real e cria 1 clip', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    const s = await getState(page);
    expect(s.video.url).toContain('mock-storage');
    expect(s.video.duration).toBeGreaterThan(1.2);
    expect(s.clips).toHaveLength(1);
    expect(s.clips[0].source_out).toBeCloseTo(s.video.duration, 1);
  });

  test('autosave dispara save-project em <5s apos mudanca', async ({ page }) => {
    const { saved } = await bootWithVideo(page);
    const before = saved.count;
    await page.keyboard.press('Control+b'); // split gera mudanca
    await expect.poll(() => saved.count, { timeout: 6000 }).toBeGreaterThan(before);
    expect(saved.lastState.clips.length).toBeGreaterThanOrEqual(1);
  });

  test('importar 2o video ACRESCENTA take sem resetar o projeto (multi-midia)', async ({ page }) => {
    const { makeSyntheticVideo } = await import('./helpers.mjs');
    await bootWithVideo(page, { seconds: 2 });
    // edicao em andamento: split no principal
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    await page.keyboard.press('Control+b');
    let s = await getState(page);
    const clipsAntes = s.clips.length;
    expect(clipsAntes).toBe(2);
    const videoUrlAntes = s.video.url;

    // 2o video: drop no workspace (edicao ja aberta) — deve virar TAKE
    const vid2 = await makeSyntheticVideo(page, 1);
    await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'take2.webm', { type: 'video/webm' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, vid2);

    await expect.poll(async () => (await getState(page)).clips.length, { timeout: 20000 }).toBe(clipsAntes + 1);
    s = await getState(page);
    expect(s.video.url).toBe(videoUrlAntes);           // principal NAO trocou (sem reset)
    expect(s.media.length).toBe(1);                    // take entrou no pool
    expect(s.clips.at(-1).media_id).toBe(s.media[0].id);
    // export leva a fonte do take
    const pay = await page.evaluate(async () => {
      const m = await import('/editor-v1/core/selectors.js');
      return m.exportPayload(window.__BE__.getState());
    });
    expect(pay.clips.at(-1).media_url).toContain('mock-storage');
    expect(pay.clips[0].media_url).toBe(null);         // principal
  });

  test('soltar imagem PNG cria camada de imagem e renderiza <img> no preview', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    // 1x1 PNG transparente (data URL) — rota mock devolve os bytes
    const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await page.route('**/mock-storage.test/public/**', (r) => {
      // serve imagem quando a url tiver .png; senão cai no vídeo (webm) do mock padrão
      if (r.request().url().includes('.png')) {
        return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'image/png', body: Buffer.from(PNG_B64, 'base64') });
      }
      return r.fallback();
    });
    // upload-url pra png
    await page.route('**/api/blue-editor', async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.action === 'upload-url' && body.ext === 'png') {
        return route.fulfill({ json: { upload_url: 'https://mock-storage.test/upload/img', public_url: 'https://mock-storage.test/public/seta.png', path: 'p/seta.png', bucket: 'blue-videos', expires_in: 900 } });
      }
      return route.fallback();
    });
    await page.route('**/mock-storage.test/upload/img', (r) => r.fulfill({ status: 200, body: '' }));

    await page.evaluate(async (b64) => {
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], 'seta.png', { type: 'image/png' });
      const dt = new DataTransfer(); dt.items.add(file);
      document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, PNG_B64);

    await expect.poll(async () => (await getState(page)).overlays.length, { timeout: 20000 }).toBe(1);
    const s = await getState(page);
    expect(s.overlays[0].kind).toBe('image');
    expect(s.overlays[0].url).toContain('seta.png');
    // preview renderiza um <img> dentro do container de overlay
    await expect.poll(async () =>
      await page.evaluate(() => document.querySelectorAll('.be-preview-frame img[data-kind="image"]').length)
    ).toBeGreaterThan(0);
  });
});

test.describe('edicao via teclado @smoke', () => {
  test('Ctrl+B divide no playhead; Q e W apagam; Ctrl+Z desfaz', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    // seek pro meio via API do player (precisao) e split
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    await page.keyboard.press('Control+b');
    let s = await getState(page);
    expect(s.clips).toHaveLength(2);
    expect(s.clips[0].source_out).toBeCloseTo(1.0, 1);

    // Q trima SÓ o clip sob o playhead (contrato novo 2026-07-20: nunca varre
    // a timeline — user perdia o projeto). Split deixou o clip DIREITO
    // selecionado; limpa a seleção pra agir no clip sob o playhead (o 1º).
    await page.evaluate(() => window.__BE__.store.dispatch({ type: 'SELECT_CLIP', clipId: null }));
    await page.evaluate(() => window.__BE__.player.seek(0.5));
    await page.keyboard.press('q');
    s = await getState(page);
    expect(s.clips[0].source_in).toBeGreaterThan(0.3); // 1º trimado no playhead
    expect(s.clips).toHaveLength(2);                    // 2º clip INTACTO

    // undo restaura
    await page.keyboard.press('Control+z');
    s = await getState(page);
    expect(s.clips[0].source_in).toBe(0);

    // redo aplica de novo
    await page.keyboard.press('Control+Shift+z');
    s = await getState(page);
    expect(s.clips[0].source_in).toBeGreaterThan(0.3);
  });

  test('espaco play/pausa e playhead avanca', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await page.evaluate(() => window.__BE__.player.seek(0));
    await page.keyboard.press(' ');
    await page.waitForTimeout(700);
    const t1 = await page.evaluate(() => window.__BE__.player.getTime());
    expect(t1).toBeGreaterThan(0.3);
    await page.keyboard.press(' '); // pausa
    const t2 = await page.evaluate(() => window.__BE__.player.getTime());
    await page.waitForTimeout(400);
    const t3 = await page.evaluate(() => window.__BE__.player.getTime());
    expect(Math.abs(t3 - t2)).toBeLessThan(0.05);
  });
});

test.describe('gestos de mouse na timeline @smoke', () => {
  test('click seleciona clip; borda vira trim handle; drag do handle trima', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    const r = await clipRect(page, 0);
    // click no corpo seleciona
    await page.mouse.click(r.cx, r.cy);
    let s = await getState(page);
    expect(s.selected_clip_id).toBe(s.clips[0].id);

    // drag do handle esquerdo pra direita = trim in
    const r2 = await clipRect(page, 0);
    await page.mouse.move(r2.x + 1, r2.cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(r2.x + 1 + i * 12, r2.cy);
    }
    await page.mouse.up();
    s = await getState(page);
    expect(s.clips[0].source_in).toBeGreaterThan(0.05);

    // 1 unico Ctrl+Z desfaz o trim inteiro (coalescing)
    await page.keyboard.press('Control+z');
    s = await getState(page);
    expect(s.clips[0].source_in).toBe(0);
  });

  test('scrub na regua move o playhead', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    const canvas = page.locator('#beTimeline');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 200, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 10, { steps: 5 });
    await page.mouse.up();
    const t = await page.evaluate(() => window.__BE__.player.getTime());
    expect(t).toBeGreaterThan(0.1);
  });

  test('drag reordena clips (split -> arrasta 2o pro inicio)', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    await page.keyboard.press('Control+b');
    let s = await getState(page);
    const [c1, c2] = s.clips.map(c => c.id);

    // zoom fit pra ambos visiveis com folga
    await page.evaluate(() => window.__BE__.timeline.zoomFit());
    const r2 = await clipRect(page, 1);
    const r1 = await clipRect(page, 0);
    // arrasta clip 2 pro comeco do clip 1
    await page.mouse.move(r2.cx, r2.cy);
    await page.mouse.down();
    await page.mouse.move(r2.cx - 20, r2.cy, { steps: 4 }); // passa threshold
    await page.mouse.move(r1.x + 8, r1.cy, { steps: 12 });
    await page.mouse.up();

    s = await getState(page);
    expect(s.clips.map(c => c.id)).toEqual([c2, c1]);
    // duracao total inalterada
    const total = s.clips.reduce((a, c) => a + c.source_out - c.source_in, 0);
    expect(total).toBeCloseTo(await page.evaluate(() => window.__BE__.getState().video.duration), 1);

    // undo restaura ordem
    await page.keyboard.press('Control+z');
    s = await getState(page);
    expect(s.clips.map(c => c.id)).toEqual([c1, c2]);
  });

  test('Esc durante drag aborta sem alterar documento', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    await page.keyboard.press('Control+b');
    const before = (await getState(page)).clips.map(c => c.id);

    await page.evaluate(() => window.__BE__.timeline.zoomFit());
    const r2 = await clipRect(page, 1);
    const r1 = await clipRect(page, 0);
    await page.mouse.move(r2.cx, r2.cy);
    await page.mouse.down();
    await page.mouse.move(r1.x + 8, r1.cy, { steps: 10 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    const after = (await getState(page)).clips.map(c => c.id);
    expect(after).toEqual(before);
    // FSM voltou pra idle
    expect(await page.evaluate(() => window.__BE__.timeline.getFsmName())).toBe('idle');
  });
});

test.describe('textos @smoke', () => {
  test('adicionar texto abre painel; editar reflete no overlay; drag no preview move x/y', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await page.evaluate(() => window.__BE__.player.seek(0.5));
    await page.locator('#beAddText').click();
    await expect(page.locator('#beTextPanel')).toBeVisible();

    await page.locator('#beTextContent').fill('TESTE E2E');
    let s = await getState(page);
    expect(s.texts[0].content).toBe('TESTE E2E');

    // overlay visivel com o texto
    const ov = page.locator('.be-text-overlay');
    await expect(ov).toHaveText('TESTE E2E');

    // drag do texto no preview
    const box = await ov.boundingBox();
    const x0pct = s.texts[0].x_pct;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    s = await getState(page);
    expect(s.texts[0].x_pct).toBeGreaterThan(x0pct + 0.02);
    expect(s.texts[0].x_pct).toBeLessThanOrEqual(1);
  });
});

test.describe('export @smoke', () => {
  test('payload do edit-v0 espelha o contrato (clips efetivos, texts ativos)', async ({ page }) => {
    let editPayload = null;
    const saved = await mockBackend(page);
    await page.route('**/api/blue-editor', async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.action === 'edit-v0') {
        editPayload = body;
        return route.fulfill({ json: { ok: true, project_id: body.project_id, railway_job_id: 'rj-1' } });
      }
      if (body.action === 'status-v0') {
        return route.fulfill({ json: { status: 'done', progresso: 100, output_url: 'https://mock-storage.test/out.mp4' } });
      }
      if (body.action === 'save-project') {
        saved.count++;
        return route.fulfill({ json: { ok: true, project_id: 'proj-e2e-1' } });
      }
      if (body.action === 'load-project') return route.fulfill({ json: { project: null } });
      if (body.action === 'list-projects') return route.fulfill({ json: { projects: [] } });
      if (body.action === 'upload-url') return route.fulfill({
        json: { upload_url: 'https://mock-storage.test/upload/video', public_url: 'https://mock-storage.test/public/video.webm', path: 'p', bucket: 'b', expires_in: 900 },
      });
      return route.fulfill({ json: { ok: true } });
    }); // registrada por ULTIMO -> tem precedencia sobre a rota do mockBackend

    // bootWithVideo ja mockou rotas base; refazemos o essencial:
    await page.goto('/blueEditor-app');
    await expect(page.locator('#beDrop')).toBeVisible({ timeout: 15000 });
    const { makeSyntheticVideo, routeUploadedVideo, uploadVideoViaDrop } = await import('./helpers.mjs');
    const vid = await makeSyntheticVideo(page, 2);
    await routeUploadedVideo(page, vid);
    await uploadVideoViaDrop(page, vid);

    // split + desativa 1o clip + adiciona texto
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    await page.keyboard.press('Control+b');
    await page.evaluate(() => {
      const s = window.__BE__.getState();
      window.__BE__.store.dispatch({ type: 'TOGGLE_CLIP', clipId: s.clips[0].id });
      window.__BE__.store.dispatch({ type: 'ADD_TEXT', props: { content: 'X', start_sec: 0, end_sec: 1 } });
    });

    await page.locator('#beExportBtn').click();
    await expect(page.locator('#beExportDone')).toBeVisible({ timeout: 15000 });

    // valida payload
    expect(editPayload).toBeTruthy();
    const ps = editPayload.project_state;
    expect(ps.clips.filter(c => c.active !== false)).toHaveLength(1);
    expect(ps.texts).toHaveLength(1);
    expect(ps.video.url).toContain('mock-storage');
    // link de download presente
    await expect(page.locator('#beExportLink')).toHaveAttribute('href', /out\.mp4/);
  });
});

test.describe('mobile touch @mobile', () => {
  test('long-press + drag reordena clips no touch', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    // split via botao (mobile nao tem teclado)
    await page.locator('#beSplit').click();
    let s = await getState(page);
    expect(s.clips).toHaveLength(2);
    const [c1, c2] = s.clips.map(c => c.id);

    await page.evaluate(() => window.__BE__.timeline.zoomFit());
    const r2 = await clipRect(page, 1);
    const r1 = await clipRect(page, 0);

    // long-press (300ms) + drag via CDP touch
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r2.cx, y: r2.cy }] });
    await page.waitForTimeout(420); // > LONG_PRESS_MS
    for (let i = 1; i <= 10; i++) {
      const x = r2.cx + (r1.x + 8 - r2.cx) * (i / 10);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: r2.cy }] });
      await page.waitForTimeout(30);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    s = await getState(page);
    expect(s.clips.map(c => c.id)).toEqual([c2, c1]);
  });

  test('swipe horizontal na track faz pan (nao drag)', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await page.evaluate(() => {
      window.__BE__.timeline.zoomBy(4); // zoom pra ter o que scrollar
    });
    const vp0 = await page.evaluate(() => window.__BE__.timeline.getViewport().scrollX);
    // toca no CENTRO VISIVEL do canvas (o clip com zoom cobre a tela toda)
    const box = await page.locator('#beTimeline').boundingBox();
    const tx = box.x + box.width / 2;
    const ty = box.y + 26 + 8 + 28; // track de video
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty, id: 1 }] });
    // move IMEDIATO (antes do long-press) = pan. Swipe pra DIREITA volta pro
    // inicio da timeline (scroll diminui) — pra frente esta clampado no fim.
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx + i * 15, y: ty, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const vp1 = await page.evaluate(() => window.__BE__.timeline.getViewport().scrollX);
    expect(vp1).toBeLessThan(vp0 - 30);
    // ordem dos clips intacta
    const s = await getState(page);
    expect(s.clips).toHaveLength(1);
  });
});

test.describe('audio detach @smoke', () => {
  test('Ctrl+Shift+S separa audio em clips; Delete remove; export muta video', async ({ page }) => {
    const { bootWithVideo, getState } = await import('./helpers.mjs');
    await bootWithVideo(page, { seconds: 2 });

    // Ctrl+Shift+S destaca -> clips de audio kind video
    await page.keyboard.press('Control+Shift+s');
    let s = await getState(page);
    expect(s.audio_detached).toBe(true);
    expect(s.audio_clips.length).toBeGreaterThanOrEqual(1);
    expect(s.audio_clips[0].kind).toBe('video');
    expect(s.selected_audio_id).toBe(s.audio_clips[0].id);

    // painel contextual do audio
    await expect(page.locator('#bePropsAudio')).toBeVisible();

    // undo/redo
    await page.keyboard.press('Control+z');
    s = await getState(page);
    expect(s.audio_detached).toBe(false);
    expect(s.audio_clips).toHaveLength(0);
    await page.keyboard.press('Control+Shift+Z');
    s = await getState(page);
    expect(s.audio_detached).toBe(true);

    // Delete remove o clip de audio -> export com video mudo
    await page.evaluate(() => {
      const st = window.__BE__.getState();
      window.__BE__.store.dispatch({ type: 'SELECT_AUDIO_CLIP', audioId: st.audio_clips[0].id });
    });
    await page.keyboard.press('Delete');
    s = await getState(page);
    expect(s.audio_clips).toHaveLength(0);
    const payload = await page.evaluate(async () => {
      const m = await import('/editor-v1/core/selectors.js');
      return m.exportPayload(window.__BE__.getState());
    });
    expect(payload.volumes.video).toBe(0);
    expect(payload.audio_clips).toHaveLength(0);
  });

  test('audio importado corta com Ctrl+B e move com drag (split por faixa)', async ({ page }) => {
    const { bootWithVideo, getState } = await import('./helpers.mjs');
    await bootWithVideo(page, { seconds: 2 });
    // injeta um audio clip direto (upload de audio real e coberto por unit)
    await page.evaluate(() => {
      window.__BE__.store.dispatch({ type: 'ADD_AUDIO_CLIP', media: { url: 'https://mock-storage.test/public/video.webm', filename: 'trilha', duration: 2 } });
    });
    let s = await getState(page);
    expect(s.audio_clips).toHaveLength(1);
    expect(s.selected_audio_id).toBe(s.audio_clips[0].id);

    // Ctrl+B com AUDIO selecionado corta o AUDIO (nao o video)
    await page.evaluate(() => window.__BE__.player.seek(1.0));
    await page.keyboard.press('Control+b');
    s = await getState(page);
    expect(s.audio_clips).toHaveLength(2);   // audio dividido
    expect(s.clips).toHaveLength(1);          // video intacto
    expect(s.audio_clips[1].start).toBeCloseTo(1.0, 1);
  });
});

test.describe('legendas automaticas @smoke', () => {
  // cobre o caminho que quebrou em 2026-07-20: modo palavra-por-palavra
  async function mockCaptions(page) {
    // route adicionada DEPOIS do mockBackend => tem precedencia (LIFO)
    await page.route('**/api/blue-editor', async (route) => {
      const body = route.request().postDataJSON() || {};
      if (body.action === 'auto-captions') {
        return route.fulfill({ json: {
          ok: true,
          captions: [{ start: 0.2, end: 1.4, text: 'ola mundo teste' }],
          words: [
            { word: 'ola',   start: 0.2, end: 0.5 },
            { word: 'mundo', start: 0.6, end: 0.9 },
            { word: 'teste', start: 1.0, end: 1.4 },
          ],
        } });
      }
      return route.fallback();
    });
  }

  test('modo palavra gera 1 texto por palavra sincronizado; frase gera bloco', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await mockCaptions(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    // abre o painel dedicado de Legendas (novo fluxo: escolher estilo ANTES)
    await page.click('#beAutoCaptions');
    await expect(page.locator('#bePropsCaptions')).toBeVisible();
    // escolhe o modo "Palavra por palavra" pelo card
    await page.click('.be-cap-card[data-mode="palavra"]');
    await page.click('#beAutoCaptions2');

    await expect.poll(async () => {
      const s = await getState(page);
      return s.texts.filter(t => t.caption).length;
    }, { timeout: 10000 }).toBe(3);

    const s = await getState(page);
    const caps = s.texts.filter(t => t.caption);
    expect(caps[0].content).toBe('ola');
    expect(caps[0].start_sec).toBeCloseTo(0.2, 2);
    expect(caps[1].start_sec).toBeCloseTo(0.6, 2);  // acompanha a fala
    expect(errors).toEqual([]);

    // trocar modo pra Multilinha (frase) regenera SEM nova transcricao
    await page.click('.be-cap-card[data-mode="frase"]');
    await expect.poll(async () => {
      const s2 = await getState(page);
      return s2.texts.filter(t => t.caption).length;
    }).toBe(1);
    expect(errors).toEqual([]);
  });

  test('transcrição clicável seleciona a legenda; "Aplicar a todas" muda cor de TODAS', async ({ page }) => {
    await bootWithVideo(page, { seconds: 2 });
    await mockCaptions(page);
    await page.click('#beAutoCaptions');
    await page.click('.be-cap-card[data-mode="palavra"]');
    await page.click('#beAutoCaptions2');
    await expect.poll(async () => (await getState(page)).texts.filter(t => t.caption).length, { timeout: 10000 }).toBe(3);

    // seleciona a 1ª legenda pra abrir o painel de texto
    await page.evaluate(() => {
      const caps = window.__BE__.getState().texts.filter(t => t.caption).sort((a, b) => a.start_sec - b.start_sec);
      window.__BE__.store.dispatch({ type: 'SELECT_TEXT', textId: caps[0].id });
    });
    await expect(page.locator('#beTextPanel')).toBeVisible();
    await expect(page.locator('#beCapApplyAllRow')).toBeVisible(); // só aparece em legenda

    // aba Legendas mostra a transcrição completa e clicar seleciona a 2ª
    await page.click('#beTextTabs [data-ttab="legendas"]');
    const rows = page.locator('.be-transcript-row');
    await expect(rows).toHaveCount(3);
    await rows.nth(1).click();
    let s = await getState(page);
    const caps = s.texts.filter(t => t.caption).sort((a, b) => a.start_sec - b.start_sec);
    expect(s.selected_text_id).toBe(caps[1].id); // clicou → selecionou a 2ª

    // "Aplicar a todas" MARCADO: mudar a cor aplica em TODAS as legendas
    await page.evaluate(() => { document.getElementById('beCapApplyAll').checked = true; });
    await page.evaluate(() => {
      const el = document.getElementById('beTextColor');
      el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    s = await getState(page);
    const allRed = s.texts.filter(t => t.caption).every(t => t.color === '#ff0000');
    expect(allRed).toBe(true);

    // DESMARCADO: muda só a selecionada
    await page.evaluate(() => { document.getElementById('beCapApplyAll').checked = false; });
    await page.evaluate(() => {
      const el = document.getElementById('beTextColor');
      el.value = '#00ff00'; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    s = await getState(page);
    const greens = s.texts.filter(t => t.caption && t.color === '#00ff00');
    expect(greens.length).toBe(1); // só a selecionada
  });
});

test.describe('agulha + config abas @smoke', () => {
  test('#1 clique 1x no vazio move a agulha; #3 Escala/Opacidade aplicam no preview', async ({ page }) => {
    await bootWithVideo(page, { seconds: 3 });

    // #1 — clique 1x na régua/timeline move a agulha pro ponto (via seek do down)
    const canvas = page.locator('#beTimeline');
    const box = await canvas.boundingBox();
    await page.evaluate(() => window.__BE__.player.seek(0));
    // clica no meio horizontal da timeline (área da régua, y perto do topo)
    await page.mouse.click(box.x + box.width * 0.45, box.y + 10);
    const t1 = await page.evaluate(() => window.__BE__.player.getTime());
    expect(t1).toBeGreaterThan(0.2); // agulha andou

    // #3 — seleciona a cena e mexe nos sliders da aba Vídeo>Básico
    await page.evaluate(() => {
      const st = window.__BE__.getState();
      window.__BE__.store.dispatch({ type: 'SELECT_CLIP', clipId: st.clips[0].id });
    });
    await expect(page.locator('#bePropsClip')).toBeVisible();
    await expect(page.locator('#beClipScale')).toBeVisible();

    // Escala 100 -> 70
    await page.locator('#beClipScale').fill('70');
    await page.locator('#beClipScale').dispatchEvent('input');
    let clip = await page.evaluate(() => window.__BE__.getState().clips[0]);
    expect(clip.scale).toBeCloseTo(0.7, 2);
    // o <video> do preview recebeu o transform
    const tf = await page.evaluate(() => document.getElementById('beVideo').style.transform);
    expect(tf).toContain('scale');

    // Opacidade 100 -> 40
    await page.locator('#beClipOpacity').fill('40');
    await page.locator('#beClipOpacity').dispatchEvent('input');
    clip = await page.evaluate(() => window.__BE__.getState().clips[0]);
    expect(clip.opacity).toBeCloseTo(0.4, 2);
    const op = await page.evaluate(() => document.getElementById('beVideo').style.opacity);
    expect(parseFloat(op)).toBeCloseTo(0.4, 1);

    // troca de aba: Áudio mostra placeholder, Vídeo esconde
    await page.locator('#beCfgTabs .be-cfg-tab[data-tab="audio"]').click();
    await expect(page.locator('.be-cfg-panel[data-panel="audio"]')).toBeVisible();
    await expect(page.locator('.be-cfg-panel[data-panel="video"]')).toBeHidden();
  });
});

test.describe('velocidade @smoke', () => {
  test('aba Velocidade acelera SÓ a cena selecionada; duração da timeline muda', async ({ page }) => {
    await bootWithVideo(page, { seconds: 3 });
    const durAntes = await page.evaluate(() => window.__BE__.player.getDuration());

    await page.evaluate(() => {
      const st = window.__BE__.getState();
      window.__BE__.store.dispatch({ type: 'SELECT_CLIP', clipId: st.clips[0].id });
    });
    // abre a aba Velocidade
    await page.locator('#beCfgTabs .be-cfg-tab[data-tab="velocidade"]').click();
    await expect(page.locator('#beClipSpeed')).toBeVisible();

    // acelera pra 2x (slider log: value 100 -> 10^1 = 10x; value ~30 -> 2x)
    // usa a API pra precisão do valor e valida o efeito no estado/duração
    await page.evaluate(() => {
      const id = window.__BE__.getState().clips[0].id;
      window.__BE__.store.dispatch({ type: 'SET_SPEED', target: 'clip', id, speed: 2 });
    });
    const clip = await page.evaluate(() => window.__BE__.getState().clips[0]);
    expect(clip.speed).toBe(2);
    const durDepois = await page.evaluate(() => window.__BE__.player.getDuration());
    expect(durDepois).toBeLessThan(durAntes - 0.5); // ficou mais curto

    // o slider reflete a velocidade ao reabrir a seleção
    await page.evaluate(() => window.__BE__.store.dispatch({ type: 'SELECT_CLIP', clipId: null }));
    await page.evaluate(() => {
      const id = window.__BE__.getState().clips[0].id;
      window.__BE__.store.dispatch({ type: 'SELECT_CLIP', clipId: id });
    });
    const label = await page.locator('#beClipSpeedVal').textContent();
    expect(label).toBe('2.00x');
  });
});
