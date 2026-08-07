# Look Tina — backend (para a VPS)

Este servidor é bem simples: serve o site (`looks_tina.html` e as pastas
`pecas/`, `thumbs/`, etc.) e guarda 3 arquivos de dados (peças avulsas, looks
montados e o catálogo) em disco, em vez de só no navegador. Assim o site
sincroniza entre celular e computador.

Não usa banco de dados (Postgres, MySQL, etc.) — só arquivos JSON dentro da
pasta `server/data/`, criada automaticamente.

## 1. Pré-requisitos na VPS

- Node.js 18 ou mais novo (`node -v` pra conferir). Se não tiver:
  ```
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```
- Git (`git -v`)

## 2. Clonar o repositório

```bash
cd /opt   # ou a pasta que preferir
git clone https://github.com/tinajpvalle/LOOKSTINA.git
cd LOOKSTINA/server
npm install
```

## 3. Testar rodando na mão

```bash
node server.js
```

Deve aparecer:

```
Look Tina backend rodando em http://localhost:4001
Servindo site estático de: /opt/LOOKSTINA
Dados salvos em: /opt/LOOKSTINA/server/data
```

Abra `http://IP_DA_VPS:4001/looks_tina.html` no navegador pra conferir que
o site carrega. Depois pare com Ctrl+C.

Por padrão usa a porta **4001**. Pra mudar: `PORT=8080 node server.js`.

## 4. Deixar rodando sempre (systemd)

Crie o arquivo `/etc/systemd/system/looks-tina.service`:

```ini
[Unit]
Description=Look Tina backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/LOOKSTINA/server
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PORT=4001
# Environment=API_KEY=uma-senha-so-sua   (opcional, ver seção 6)
User=www-data

[Install]
WantedBy=multi-user.target
```

Depois:

```bash
sudo systemctl daemon-reload
sudo systemctl enable looks-tina
sudo systemctl start looks-tina
sudo systemctl status looks-tina   # confirma que está "active (running)"
```

Assim, se a VPS reiniciar ou o processo cair, ele volta sozinho.

## 5. Deixar acessível de fora (domínio + HTTPS, opcional mas recomendado)

Se tiver um domínio/subdomínio apontando pro IP da VPS, use Nginx como proxy
reverso na frente do Node (porta 4001), com HTTPS via Let's Encrypt:

```nginx
server {
    listen 80;
    server_name looks.seudominio.com;

    location / {
        proxy_pass http://localhost:4001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d looks.seudominio.com
```

Sem domínio, dá pra usar `http://IP_DA_VPS:4001/looks_tina.html` direto (sem
HTTPS) — funciona, só não é criptografado.

## 6. Proteção opcional de escrita (API_KEY)

Sem `API_KEY` configurada, qualquer pessoa com o link consegue *ler* e
*escrever* nos dados (peças avulsas, looks, catálogo) — como o site inteiro já
é público hoje no GitHub Pages, isso mantém o mesmo nível de exposição de
antes. Se quiser um mínimo de proteção contra escrita por terceiros, defina
uma senha:

```
Environment=API_KEY=uma-senha-bem-grande-aqui
```

(No arquivo do systemd, ou como variável de ambiente antes de rodar
`node server.js`.) Isso não é necessário pra funcionar — é só uma camada
extra opcional.

## 7. Atualizar o site depois (git pull)

Sempre que eu (Claude) publicar uma atualização no GitHub:

```bash
cd /opt/LOOKSTINA
git pull
sudo systemctl restart looks-tina
```

## Como funciona por baixo dos panos

- `GET /api/data/:chave` — devolve o JSON salvo (ou `null` se ainda não
  existir nada).
- `PUT /api/data/:chave` — salva um novo valor (usado automaticamente pelo
  site, você não precisa chamar isso na mão).
- Chaves usadas: `looks_tina_catalog_v1`, `looks_tina_montados_v1`,
  `looks_tina_pecas_avulsas_v1`.
- O site continua funcionando 100% mesmo se o backend cair — ele guarda uma
  cópia local (no navegador) e volta a sincronizar quando o servidor
  responder de novo.
