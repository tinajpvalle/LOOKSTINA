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
// (guard antigo: casa só na rota "crua", mantido por segurança em profundidade —
//  quem realmente barra o abuso é o middleware guardaEstaticos, mais abaixo)
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

// ── Guarda de path traversal ──
// O express.static serve a raiz do repositório inteira, e o guard app.use('/server')
// acima só enxerga a rota "crua": um pedido como
//   GET /thumbs/..%2fserver%2fserver.js
// não começa com "/server" (a barra está codificada), passa batido pelo guard, e aí
// o serve-static decodifica o %2f, resolve o ".." e entrega o fonte do backend.
// A defesa precisa ficar na origem (aqui), e não só no proxy: decodificamos primeiro,
// resolvemos o caminho absoluto, e só então decidimos.
const SERVER_DIR = path.join(REPO_ROOT, 'server');

// Bloquear só "server/" seria uma lista negra: tudo que não estivesse nela
// passaria a ser servido. Hoje Dockerfile, README.md e .git não vazam porque o
// .dockerignore os deixa de fora da imagem — mexer nesse arquivo publicaria os
// três sem nenhum aviso. Então a regra é ao contrário: só sai daqui o que está
// listado abaixo. Ao adicionar um arquivo novo ao site, inclua-o aqui.
// 'vendor' guarda o modelo de recorte de fundo (vendor/bgremoval): o .mjs da
// biblioteca e os blocos do modelo, que o navegador baixa na primeira peça avulsa.
const PASTAS_PUBLICAS = new Set(['pecas', 'thumbs', 'vendor']);
const ARQUIVOS_PUBLICOS = new Set([
  'index.html',
  'looks_tina.html',
  'manifest.json',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
]);

function guardaEstaticos(req, res, next) {
  // as rotas /api/ já foram tratadas acima e não montam caminho de disco a partir
  // da URL (a chave passa pela allowlist ALLOWED_KEYS), então não passam por aqui.
  if (req.path.startsWith('/api/')) return next();

  let decodificado;
  try {
    decodificado = decodeURIComponent(req.path);
  } catch (e) {
    // URI malformada (ex.: "%zz") — o serve-static estouraria mais adiante;
    // respondemos 400 limpo aqui mesmo.
    return res.status(400).json({ error: 'uri inválida' });
  }

  // '.' + caminho garante que a resolução parta sempre de REPO_ROOT, mesmo se o
  // decodificado vier com barra inicial (path.resolve trataria como absoluto).
  const resolvido = path.resolve(REPO_ROOT, '.' + decodificado);

  // fora da raiz do site → não existe, ponto.
  if (resolvido !== REPO_ROOT && !resolvido.startsWith(REPO_ROOT + path.sep)) {
    return res.status(404).end();
  }

  // dentro de server/ → é o backend, nunca se serve.
  // a comparação usa o separador de propósito: um startsWith puro em SERVER_DIR
  // também casaria um diretório chamado "serverX".
  if (resolvido === SERVER_DIR || resolvido.startsWith(SERVER_DIR + path.sep)) {
    return res.status(404).end();
  }

  // a raiz ("/") é o index.html, servido pelo express.static logo abaixo.
  if (resolvido === REPO_ROOT) return next();

  // do caminho já resolvido, o primeiro trecho decide: ou é uma das pastas de
  // imagens, ou é um dos arquivos soltos do site. Qualquer outra coisa não existe.
  const relativo = path.relative(REPO_ROOT, resolvido);
  const primeiro = relativo.split(path.sep)[0];
  if (!PASTAS_PUBLICAS.has(primeiro) && !ARQUIVOS_PUBLICOS.has(primeiro)) {
    return res.status(404).end();
  }

  next();
}

app.use(guardaEstaticos);

// site estático (looks_tina.html, pecas/, thumbs/, icons, manifest.json...)
app.use(express.static(REPO_ROOT));

// Nada casou: o 404 padrão do Express devolve uma página HTML com "Cannot GET
// <caminho>", que destoa do resto da API e anuncia o framework à toa.
app.use((req, res) => res.status(404).json({ error: 'não encontrado' }));

// ── Tratador de erros (último da cadeia) ──
// Sem isso o Express usa o handler padrão, que em desenvolvimento devolve o
// err.stack no corpo da resposta — vazando caminhos internos e versões de libs
// para quem manda um JSON quebrado ou um upload grande demais.
// Assinatura de 4 argumentos é obrigatória para o Express reconhecê-lo como
// error handler.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[erro]', err && err.message);

  if (res.headersSent) return next(err);

  if (err && (err.status === 413 || err.statusCode === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ error: 'arquivo grande demais' });
  }

  const jsonQuebrado =
    (err && err.type === 'entity.parse.failed') ||
    (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400));
  if (jsonQuebrado) {
    return res.status(400).json({ error: 'json inválido' });
  }

  res.status(500).json({ error: 'erro interno' });
});

app.listen(PORT, () => {
  console.log('Look Tina backend rodando em http://localhost:' + PORT);
  console.log('Servindo site estático de: ' + REPO_ROOT);
  console.log('Dados salvos em: ' + DATA_DIR);
  if (API_KEY) console.log('Proteção de escrita (x-api-key) ATIVA.');
});
