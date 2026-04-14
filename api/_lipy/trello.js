// Helper Trello (Lipy) — não-rota (dentro de api/_lipy/)

async function criarBoard({ nome }) {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return { id: `mock_board_${Date.now()}`, mock: true };
  try {
    const r = await fetch(`https://api.trello.com/1/boards?name=${encodeURIComponent(nome)}&defaultLists=false&key=${key}&token=${token}`, { method: 'POST' });
    const board = await r.json();
    const listas = ['Briefing', 'Em Criação', 'Aguardando Aprovação', 'Agendado', 'Publicado'];
    for (const l of listas) {
      await fetch(`https://api.trello.com/1/boards/${board.id}/lists?name=${encodeURIComponent(l)}&key=${key}&token=${token}`, { method: 'POST' });
    }
    return board;
  } catch (e) {
    console.error('[lipy/trello]', e);
    return null;
  }
}

async function criarCard({ list_id, nome, descricao }) {
  const key = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return { id: `mock_card_${Date.now()}`, mock: true };
  try {
    const r = await fetch(`https://api.trello.com/1/cards?idList=${list_id}&name=${encodeURIComponent(nome)}&desc=${encodeURIComponent(descricao || '')}&key=${key}&token=${token}`, { method: 'POST' });
    return await r.json();
  } catch {
    return null;
  }
}

module.exports = { criarBoard, criarCard };
