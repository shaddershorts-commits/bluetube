// tests/e2e/helpers.mjs — mocks de API + geracao de video sintetico no browser
import { expect } from '@playwright/test';

/** Mocka flag ligada + user com plano + APIs de projeto. */
export async function mockBackend(page, { plan = 'master', projects = [] } = {}) {
  const saved = { count: 0, lastState: null };

  await page.route('**/api/editor-flag', r => r.fulfill({ json: { enabled: true, reason: 'e2e', env: 'test' } }));
  await page.route('**/api/get-plan', r => r.fulfill({ json: { plan, email: 'e2e@test.com' } }));
  await page.route('**/api/blue-editor', async (route) => {
    const body = route.request().postDataJSON() || {};
    switch (body.action) {
      case 'load-project':
        return route.fulfill({ json: { project: null } });
      case 'list-projects':
        return route.fulfill({ json: { projects } });
      case 'save-project':
        saved.count++;
        saved.lastState = body.project_state;
        return route.fulfill({ json: { ok: true, project_id: body.project_id || 'proj-e2e-1', updated_at: new Date().toISOString() } });
      case 'upload-url':
        return route.fulfill({
          json: {
            upload_url: 'https://mock-storage.test/upload/video',
            public_url: 'https://mock-storage.test/public/video.webm',
            path: 'editor/uploads/e2e/video.webm',
            bucket: 'blue-videos',
            expires_in: 900,
          },
        });
      default:
        return route.fulfill({ json: { ok: true, mock: body.action } });
    }
  });

  // token fake pra passar o gate
  await page.addInitScript(() => localStorage.setItem('bt_token', 'e2e-token'));
  return saved;
}

/** Gera um webm real de N segundos no browser (canvas + MediaRecorder) e
 *  retorna base64. Serve como fixture de video decodavel. */
export async function makeSyntheticVideo(page, seconds = 2) {
  return await page.evaluate(async (secs) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 568; // 9:16
    const g = canvas.getContext('2d');
    const stream = canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise(res => { rec.onstop = res; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise((res) => {
      function frame() {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = `hsl(${(t * 120) % 360}, 70%, 40%)`;
        g.fillRect(0, 0, 320, 568);
        g.fillStyle = '#fff';
        g.font = '48px sans-serif';
        g.fillText(t.toFixed(1), 100, 280);
        if (t < secs) requestAnimationFrame(frame);
        else res();
      }
      frame();
    });
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buf = await blob.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }, seconds);
}

/** Roteia o PUT do upload + GET da public_url servindo o webm gerado. */
export async function routeUploadedVideo(page, videoB64) {
  const buf = Buffer.from(videoB64, 'base64');
  await page.route('**/mock-storage.test/upload/**', r => r.fulfill({ status: 200, body: '' }));
  await page.route('**/mock-storage.test/public/**', r => r.fulfill({
    status: 200,
    headers: { 'Access-Control-Allow-Origin': '*' },
    contentType: 'video/webm',
    body: buf,
  }));
}

/** Faz o "upload" via drop de um File webm sintetico no dropzone. */
export async function uploadVideoViaDrop(page, videoB64) {
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], 'e2e-video.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const drop = document.getElementById('beDrop');
    drop.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, videoB64);
  // espera o state receber o video
  await expect.poll(async () =>
    await page.evaluate(() => !!window.__BE__?.getState()?.video), { timeout: 20000 }
  ).toBe(true);
}

/** Setup completo: mock + goto + gera video + upload. Retorna { saved }. */
export async function bootWithVideo(page, opts = {}) {
  const saved = await mockBackend(page, opts);
  await page.goto('/blueEditor-app');
  await expect(page.locator('#beDrop')).toBeVisible({ timeout: 15000 });
  const vid = await makeSyntheticVideo(page, opts.seconds || 2);
  await routeUploadedVideo(page, vid);
  await uploadVideoViaDrop(page, vid);
  await expect(page.locator('#beWorkspace')).toBeVisible();
  return { saved };
}

export function getState(page) {
  return page.evaluate(() => window.__BE__.getState());
}

/** Geometria de um clip no canvas (coords da PAGINA, prontas pro mouse). */
export async function clipRect(page, index = 0) {
  return await page.evaluate((idx) => {
    const canvas = document.getElementById('beTimeline');
    const box = canvas.getBoundingClientRect();
    const state = window.__BE__.getState();
    const vp = window.__BE__.timeline.getViewport();
    // reproduz computeLayout basico: PAD_LEFT=16, RULER_H=26, GAP=8
    const segs = [];
    let t = 0;
    for (const c of state.clips.filter(c => c.active !== false)) {
      const dur = c.source_out - c.source_in;
      segs.push({ id: c.id, tStart: t, tEnd: t + dur });
      t += dur;
    }
    const seg = segs[idx];
    if (!seg) return null;
    const x = 16 + seg.tStart * vp.pxPerSec - vp.scrollX;
    const w = (seg.tEnd - seg.tStart) * vp.pxPerSec;
    return {
      clipId: seg.id,
      x: box.left + x,
      y: box.top + 26 + 8,
      w,
      h: 56,
      cx: box.left + x + w / 2,
      cy: box.top + 26 + 8 + 28,
    };
  }, index);
}
