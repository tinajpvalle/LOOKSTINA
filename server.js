// ── Look Tina — backend simples ──
// Guarda 3 "blocos" de dados dinâmicos em arquivos JSON (sem banco de dados
// de verdade, não precisa) e serve o site estático (looks_tina.html, pecas/,
// thumbs/, etc.) pelo mesmo processo. Isso substitui o localStorage do
// navegador por um armazenamento central, permitindo que o site sincronize
// entre aparelhos diferentes.
//
// Chaves permitidas (as mesmas usadas no localStorage do front-end):
//   - looks_tina_catalog_v1        (catálogo: 851 looks + edições da Tina)
//   - looks_tina_montados_v1       (looks montados / planejador semanal)
//   - looks_tina_pecas_avulsas_v1  (peças avulsas adicionadas por foto)
//
// Uso: node server.js  (ou "npm start" dentro da pasta server/)
// Variáveis de ambiente opcionais:
//   PORT=4001           porta em que o servidor escuta (padrão 4001)
//   API_KEY=algumasenha se definida, exige o header "x-api-key" em toda
//                       escrita (PUT). Deixe sem definir para uso simples
//                       dentro de uma rede confiável / atrás de proxy próprio.

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4001;
const API_KEY = process.env.API_KEY || null;

const REPO_ROOT = path.join(__dirname, '..'); // pasta do site (looks_tina.html, pecas/, thumbs/...)
const DATA_DIR = path.join(__dirname, 'data'); // onde os JSONs ficam guardados

const ALLOWED_KEYS = new Set([
  'looks_tina_catalog_v1',
  'looks_tina_montados_v1',
  'looks_tina_pecas_avulsas_v1'
]);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFilePath(key) {
  return path.join(DATA_DIR, key + '.json');
}

// escrita atômica: grava num arquivo temporário e renomeia por cima do
// arquivo final, pra nunca deixar um JSON pela metade no disco se o
// processo cair no meio de uma escrita.
function writeJsonAtomic(filePath, content) {
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

const app = express();
app.use(express.json({ limit: '30mb' })); // fotos das peças avulsas vêm em base64 dentro do JSON

// nunca serve os arquivos do próprio backend (server.js, package.json, data/...)
app.use('/server', (req, res) => res.status(404).end());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/data/:key', (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(404).json({ error: 'chave desconhecida' });
  const filePath = dataFilePath(key);
  if (!fs.existsSync(filePath)) return res.json({ value: null, updatedAt: null });
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: 'falha ao ler dado salvo' });
  }
});

app.put('/api/data/:key', (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(404).json({ error: 'chave desconhecida' });

  if (API_KEY) {
    const provided = req.get('x-api-key');
    if (provided !== API_KEY) return res.status(401).json({ error: 'não autorizado' });
  }

  const value = req.body && req.body.value;
  if (value === undefined) return res.status(400).json({ error: 'corpo precisa ter { value: ... }' });

  const updatedAt = new Date().toISOString();
  const toStore = JSON.stringify({ value: value, updatedAt: updatedAt });
  try {
    writeJsonAtomic(dataFilePath(key), toStore);
    res.json({ ok: true, updatedAt: updatedAt });
  } catch (e) {
    res.status(500).json({ error: 'falha ao salvar' });
  }
});

// site estático (looks_tina.html, pecas/, thumbs/, icons, manifest.json...)
app.use(express.static(REPO_ROOT));

app.listen(PORT, () => {
  console.log('Look Tina backend rodando em http://localhost:' + PORT);
  console.log('Servindo site estático de: ' + REPO_ROOT);
  console.log('Dados salvos em: ' + DATA_DIR);
  if (API_KEY) console.log('Proteção de escrita (x-api-key) ATIVA.');
});
