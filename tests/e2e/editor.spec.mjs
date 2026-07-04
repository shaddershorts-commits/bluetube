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

    // Q apaga antes do playhead
    await page.evaluate(() => window.__BE__.player.seek(0.5));
    await page.keyboard.press('q');
    s = await getState(page);
    expect(s.clips[0].source_in).toBeGreaterThan(0.3);

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
