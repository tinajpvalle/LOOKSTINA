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

// Conversão de imagem. O Safari do iPhone não sabe gerar WebP pelo navegador e
// cai pra PNG: as 6 peças avulsas dela pesavam de 394 KB a 1 MB, enquanto as do
// Alta, em WebP, têm 26 a 40 KB. A conversão passa a ser feita aqui.
// Entra como dependência opcional e o require fica protegido: se o binário não
// existir pra esta arquitetura, o servidor sobe igual e só deixa de converter —
// nunca deixa o site fora do ar por causa de otimização de foto.
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn('[aviso] sharp indisponível — as fotos serão guardadas como chegam:', e && e.message);
}

const PORT = process.env.PORT || 4001;
const API_KEY = process.env.API_KEY || null;

const REPO_ROOT = path.join(__dirname, '..'); // pasta do site (looks_tina.html, pecas/, thumbs/...)
const DATA_DIR = path.join(__dirname, 'data'); // onde os JSONs ficam guardados

const ALLOWED_KEYS = new Set([
  'looks_tina_catalog_v1',
  'looks_tina_montados_v1',
  'looks_tina_pecas_avulsas_v1',
  'looks_tina_proxsemana_v1',   // plano da próxima semana ({Seg: idDoLook})
  'looks_tina_pecas_arquivadas_v1', // peças aposentadas (doadas, perdidas): ids
  'looks_tina_proxsemana_dias_v1',  // nota/em casa/ocasião de cada dia da próxima semana
  'looks_tina_proxsemana_noite_v1', // look da noite de cada dia da próxima semana
  'looks_tina_inspiracoes_v1',      // prints de referência + paleta lida da foto
  'looks_tina_preferencias_v1',     // sim/não por etiqueta, aprendido do que ela recusa
  'looks_tina_combinacoes_v1',      // gostei/não gostei por par de peças
  'looks_tina_regras_v1'            // regras escritas por ela ("X com Y não fica bom"),
  'looks_tina_trips_v1'             // malas de viagem montadas a partir dos sapatos
]);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function dataFilePath(key) {
  return path.join(DATA_DIR, key + '.json');
}

// Cópia da versão anterior de cada chave.
// Em 17/08/2026 um aparelho sem nada salvo mandou o catálogo embutido por cima
// do dela e 26 looks importados sumiram — sem nada em disco pra voltar atrás.
// O front-end foi corrigido pra não fazer isso, mas uma cópia da última versão
// custa quase nada e transforma um acidente desses em um comando.
function previousFilePath(key) {
  return path.join(DATA_DIR, key + '.anterior.json');
}

// escrita atômica: grava num arquivo temporário e renomeia por cima do
// arquivo final, pra nunca deixar um arquivo pela metade no disco se o
// processo cair no meio de uma escrita. Serve pra JSON e pra foto (Buffer).
function writeJsonAtomic(filePath, content) {
  const tmpPath = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmpPath, content, typeof content === 'string' ? 'utf-8' : undefined);
  fs.renameSync(tmpPath, filePath);
}

const app = express();
app.use(express.json({ limit: '30mb' })); // fotos das peças avulsas vêm em base64 dentro do JSON

// nunca serve os arquivos do próprio backend (server.js, package.json, data/...)
// (guard antigo: casa só na rota "crua", mantido por segurança em profundidade —
//  quem realmente barra o abuso é o middleware guardaEstaticos, mais abaixo)
app.use('/server', (req, res) => res.status(404).end());

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), converteFoto: !!sharp });
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

// ── Fotos dos looks importados ──
// Elas iam em base64 dentro do próprio catálogo. Cada foto pesa uns 250 KB, e o
// catálogo passou de 0,2 MB para 4,7 MB — perto do teto de armazenamento que o
// Safari do iPhone dá pra um site (~5 MB), onde a gravação passa a falhar
// calada. Aqui a foto vira arquivo em disco, como as de pecas/ e thumbs/, e o
// catálogo guarda só o caminho.
// Dentro de DATA_DIR de propósito: só ./server/data é volume no docker-compose.
// Uma pasta em /app viveria dentro da imagem e sumiria no deploy seguinte,
// levando as fotos junto.
const IMPORTADOS_DIR = path.join(DATA_DIR, 'importados');
if (!fs.existsSync(IMPORTADOS_DIR)) fs.mkdirSync(IMPORTADOS_DIR, { recursive: true });

const TIPOS_DE_FOTO = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Diagnóstico: dá pra saber de fora se a conversão está ligada neste servidor.
// Sem isso, "por que a foto continua pesada?" vira adivinhação.

app.post('/api/foto', (req, res) => {
  if (API_KEY) {
    const provided = req.get('x-api-key');
    if (provided !== API_KEY) return res.status(401).json({ error: 'não autorizado' });
  }

  const dataUrl = req.body && req.body.dataUrl;
  if (typeof dataUrl !== 'string') return res.status(400).json({ error: 'corpo precisa ter { dataUrl }' });

  const m = /^data:([a-z/+-]+);base64,([\s\S]+)$/i.exec(dataUrl.trim());
  if (!m) return res.status(400).json({ error: 'dataUrl inválida' });

  const extensao = TIPOS_DE_FOTO[m[1].toLowerCase()];
  if (!extensao) return res.status(415).json({ error: 'tipo de imagem não aceito' });

  let bytes;
  try { bytes = Buffer.from(m[2], 'base64'); }
  catch (e) { return res.status(400).json({ error: 'base64 inválido' }); }
  if (!bytes.length) return res.status(400).json({ error: 'imagem vazia' });

  // nome sorteado aqui, nunca vindo do cliente: nome de arquivo escolhido de
  // fora é o caminho clássico pra escrever onde não devia.
  const base = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

  function guardar(conteudo, ext) {
    const nome = base + ext;
    writeJsonAtomic(path.join(IMPORTADOS_DIR, nome), conteudo);
    res.json({ ok: true, caminho: 'importados/' + nome });
  }

  if (!sharp) {
    try { return guardar(bytes, extensao); }
    catch (e) { return res.status(500).json({ error: 'falha ao guardar a foto' }); }
  }

  // 600px no lado maior é o tamanho das peças do Alta; a transparência do
  // recorte é preservada. `withoutEnlargement` não estica foto pequena.
  sharp(bytes)
    .rotate()                          // respeita a orientação EXIF do iPhone
    .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 })
    .toBuffer()
    .then((convertida) => {
      // Se a conversão sair maior que o original (raro, mas acontece em imagem
      // já bem comprimida), fica o original.
      if (convertida.length < bytes.length) return guardar(convertida, '.webp');
      return guardar(bytes, extensao);
    })
    .catch((e) => {
      console.error('[aviso] conversão falhou, guardando como veio:', e && e.message);
      try { guardar(bytes, extensao); }
      catch (e2) { res.status(500).json({ error: 'falha ao guardar a foto' }); }
    });
});

// A versão imediatamente anterior de uma chave, pra desfazer uma sobrescrita.
app.get('/api/data/:key/anterior', (req, res) => {
  const key = req.params.key;
  if (!ALLOWED_KEYS.has(key)) return res.status(404).json({ error: 'chave desconhecida' });
  const filePath = previousFilePath(key);
  if (!fs.existsSync(filePath)) return res.json({ value: null, updatedAt: null });
  try {
    res.json(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (e) {
    res.status(500).json({ error: 'falha ao ler a cópia anterior' });
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
    const filePath = dataFilePath(key);
    if (fs.existsSync(filePath)) {
      try { fs.copyFileSync(filePath, previousFilePath(key)); }
      catch (e) { console.error('[aviso] não consegui guardar a cópia anterior de', key, e && e.message); }
    }
    writeJsonAtomic(filePath, toStore);
    res.json({ ok: true, updatedAt: updatedAt });
  } catch (e) {
    res.status(500).json({ error: 'falha ao salvar' });
  }
});

// As fotos moram em server/data/importados (volume), fora da raiz do site, então
// precisam de rota própria. O express.static resolve o caminho a partir da pasta
// e barra ".." sozinho.
app.use('/importados', express.static(IMPORTADOS_DIR, {
  maxAge: '30d',      // o nome do arquivo é único; o conteúdo nunca muda
  fallthrough: true,
  index: false,
  dotfiles: 'ignore'
}));

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

// ── Conversão das fotos que já estavam em disco ──
// As primeiras fotos subiram antes de existir conversão: 26 JPEGs de ~250 KB
// que o celular dela baixa toda vez que rola o catálogo. Converter aqui evita
// que ela gaste dados baixando e reenviando as mesmas fotos.
// O arquivo antigo não é apagado: se a troca de referência falhar no meio, o
// caminho velho continua funcionando. Roda uma vez só, marcado no volume.
const MARCA_CONVERSAO = path.join(DATA_DIR, '.fotos-convertidas');

function converterFotosAntigas() {
  if (!sharp || fs.existsSync(MARCA_CONVERSAO)) return;

  let arquivos;
  try { arquivos = fs.readdirSync(IMPORTADOS_DIR); }
  catch (e) { return; }

  const pendentes = arquivos.filter((n) => /\.(jpe?g|png)$/i.test(n));
  if (!pendentes.length) {
    fs.writeFileSync(MARCA_CONVERSAO, new Date().toISOString());
    return;
  }

  const trocas = {};
  let feitas = 0;

  const conversoes = pendentes.map((nome) => {
    const origem = path.join(IMPORTADOS_DIR, nome);
    const destinoNome = nome.replace(/\.[^.]+$/, '') + '.webp';
    const destino = path.join(IMPORTADOS_DIR, destinoNome);
    if (fs.existsSync(destino)) { trocas[nome] = destinoNome; return Promise.resolve(); }
    return sharp(origem)
      .rotate()
      .resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer()
      .then((buf) => {
        const original = fs.statSync(origem).size;
        if (buf.length >= original) return; // não vale a troca
        writeJsonAtomic(destino, buf);
        trocas[nome] = destinoNome;
        feitas++;
      })
      .catch((e) => console.error('[conversão] falhou em', nome, e && e.message));
  });

  Promise.all(conversoes).then(() => {
    const nomes = Object.keys(trocas);
    if (nomes.length) {
      ALLOWED_KEYS.forEach((chave) => {
        const arquivo = dataFilePath(chave);
        if (!fs.existsSync(arquivo)) return;
        try {
          let conteudo = fs.readFileSync(arquivo, 'utf-8');
          let mudou = false;
          nomes.forEach((antigo) => {
            const de = 'importados/' + antigo;
            if (conteudo.indexOf(de) === -1) return;
            conteudo = conteudo.split(de).join('importados/' + trocas[antigo]);
            mudou = true;
          });
          if (!mudou) return;
          fs.copyFileSync(arquivo, previousFilePath(chave)); // dá pra voltar atrás
          writeJsonAtomic(arquivo, conteudo);
          console.log('[conversão] referências atualizadas em', chave);
        } catch (e) {
          console.error('[conversão] não consegui atualizar', chave, e && e.message);
        }
      });
    }
    fs.writeFileSync(MARCA_CONVERSAO, new Date().toISOString());
    console.log('[conversão] ' + feitas + ' foto(s) convertida(s) para WebP');
  });
}

app.listen(PORT, () => {
  console.log('Look Tina backend rodando em http://localhost:' + PORT);
  console.log('Servindo site estático de: ' + REPO_ROOT);
  console.log('Dados salvos em: ' + DATA_DIR);
  if (API_KEY) console.log('Proteção de escrita (x-api-key) ATIVA.');
  if (sharp) setTimeout(converterFotosAntigas, 2000); // depois do servidor já estar atendendo
});
