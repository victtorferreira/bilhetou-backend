# Instalar o WAHA na OVHcloud

Este guia prepara um servidor novo e dedicado ao WAHA. Backend e PostgreSQL continuam no Render, e o frontend continua na Vercel. Os arquivos de implantação estão em `deploy/ovh`. A configuração foi preparada localmente; nenhum servidor foi contratado, acessado ou instalado durante essa preparação.

## 1. Contratar a VPS

Em https://www.ovhcloud.com/en/vps/, escolha um plano x86 com pelo menos 2 vCPUs, 4 GB de RAM, 40 GB de SSD e IPv4 público. Os nomes e preços podem variar conforme o país: confira os recursos no pedido. Escolha Ubuntu 24.04 LTS. Não precisa contratar cPanel, Plesk, Windows ou banco adicional. Use datacenter convencional: a página da OVH informa restrições para Docker em Local Zones.

Conclua o pedido e espere o servidor aparecer no painel. Guarde o IPv4 e as instruções de SSH recebidas da OVH. Não reinstale uma VPS que já tenha dados: este roteiro pressupõe uma VPS nova.

## 2. Preparar o endereço HTTPS

Você precisa de um domínio seu ou de acesso ao DNS de um domínio. Crie um registro **A**:

| Campo | Valor de exemplo |
| --- | --- |
| Nome | waha |
| Tipo | A |
| Destino | IPv4 da VPS |
| TTL | Padrão/automático |

O endereço resultante será `waha.seudominio.com`. Substitua esse exemplo pelo seu domínio em todos os comandos. Se usar Cloudflare, deixe inicialmente em **DNS only**, sem proxy. Não crie registro AAAA sem configurar corretamente o IPv6 correspondente.

No PowerShell do seu computador, confirme:

```powershell
Resolve-DnsName waha.seudominio.com -Type A
```

O resultado precisa apontar para o IPv4 contratado. O endereço `bilhetou.vercel.app` não permite criar um subdomínio DNS seu sob `vercel.app`; se esse for o único endereço atual, defina um domínio próprio antes de prosseguir com o HTTPS deste guia.

## 3. Acessar a VPS pelo Windows

Abra PowerShell e substitua `IP_DA_VPS`:

```powershell
ssh ubuntu@IP_DA_VPS
```

Use o usuário e a senha/chave indicados pela OVH; em Ubuntu, o usuário costuma ser `ubuntu`. Confira a identificação do servidor antes de aceitar a chave SSH. Ao digitar uma senha, nenhum caractere aparece: isso é normal.

Daqui até o envio dos arquivos, execute os comandos **dentro da VPS**, no terminal SSH.

## 4. Instalar Docker pelo repositório oficial

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl openssl ufw
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
```

Depois, copie o bloco inteiro:

```bash
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
```

Instale e confira:

```bash
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker version
sudo docker compose version
mkdir -p ~/bilhetou-waha
```

Em uma VPS recém-criada com SSH padrão na porta 22, configure o firewall:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Confirme a pergunta do UFW. Se seu SSH usa outra porta, libere essa porta antes de ativar o firewall. Se houver firewall externo na OVH, permita também o tráfego de entrada necessário em 22, 80 e 443. O WAHA não publica a porta 3000; somente o Caddy expõe HTTP/HTTPS. Portas publicadas pelo Docker têm regras próprias e podem contornar o UFW, por isso não adicione `3000:3000` à configuração.

## 5. Enviar os arquivos

Abra **outro PowerShell no seu computador**, mantendo o SSH disponível, e execute:

```powershell
Set-Location 'C:\Users\Victor\Documents\Bilhetou\dia-de-sorte-api-starter\dia-de-sorte-api'
scp deploy/ovh/compose.yaml deploy/ovh/Caddyfile deploy/ovh/init.sh ubuntu@IP_DA_VPS:~/bilhetou-waha/
```

Troque usuário/IP se necessário. Esses arquivos não contêm senhas. O `.env` será criado diretamente na VPS.

## 6. Criar as chaves e iniciar

Volte ao terminal SSH **da VPS**:

```bash
cd ~/bilhetou-waha
sed -i 's/\r$//' init.sh
bash init.sh waha.seudominio.com
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d
sudo docker compose ps
```

O script cria `.env` com três segredos aleatórios distintos e permissão restrita. Ele não sobrescreve um `.env` existente. O comando `config --quiet` valida sem imprimir as chaves.

O Caddy solicita e renova o certificado HTTPS automaticamente. O DNS deve estar correto e 80/443 precisam estar acessíveis. A primeira inicialização pode levar alguns minutos. Se falhar:

```bash
sudo docker compose logs --tail=80 caddy
sudo docker compose logs --tail=80 waha
```

Antes de compartilhar logs, confira e remova eventuais credenciais. Para ler as senhas diretamente no servidor, use `nano .env` ou `less .env`; não publique o conteúdo nem o envie no chat.

## 7. Conectar o número remetente

No navegador, abra `https://waha.seudominio.com/dashboard`.

1. Entre com usuário `admin` e a senha `WAHA_DASHBOARD_PASSWORD` do `.env` da VPS.
2. Se o painel solicitar uma conexão, use a URL `https://waha.seudominio.com` e o valor de `WAHA_API_KEY`. Não use localhost.
3. Crie/inicie a sessão `default` e abra o QR Code. Se já existir uma sessão default, use a existente.
4. No celular do número que enviará as mensagens: **WhatsApp → Aparelhos conectados → Conectar aparelho** e leia o QR Code.
5. Aguarde o estado `WORKING`.
6. No SSH, rode `sudo docker compose restart waha` e confira que a sessão volta para `WORKING` sem pedir outro QR. Isso valida a persistência antes de ativar o backend.

Os volumes mantêm as sessões e os certificados entre reinícios. Não use `docker compose down -v`: o `-v` apaga esses volumes.

## 8. Ativar no Render e publicar o frontend

No Render, abra o serviço **do backend**, em **Environment**, e adicione:

```dotenv
WAHA_ENABLED=true
WAHA_BASE_URL=https://waha.seudominio.com
WAHA_API_KEY=valor-de-WAHA_API_KEY-do-env-da-VPS
WAHA_SESSION=default
```

Copie o valor real da chave diretamente para o Render. A URL não termina em `/api` ou `/dashboard`. Essas variáveis não vão na Vercel.

As alterações locais da integração precisam estar no repositório do backend, incluindo `prisma/migrations/202610220002_whatsapp_welcome`. Mantenha:

```text
Build Command: npm ci --include=dev && npm run prisma:generate && npm run build
Start Command: npm run prisma:deploy && npm start
```

Faça backup do banco antes de aplicar migrações. Salve as variáveis e publique o backend atualizado. O `prisma:deploy` aplica a fila de mensagens no banco. Publique também o frontend atualizado na Vercel para aparecer a autorização no cadastro.

Se o backend usar um plano que dorme por inatividade, o worker só processa enquanto a API estiver acordada. Para envio consistente em segundo plano, mantenha a API em um serviço sempre ativo.

## 9. Testar o cadastro

1. No site atualizado, cadastre outro número sob seu controle, diferente do remetente.
2. Marque **Quero receber a confirmação do meu cadastro pelo WhatsApp do Bilhetou**.
3. Aguarde o processamento, que normalmente começa no próximo ciclo de 5 segundos quando não há fila.
4. Confira a mensagem no telefone de destino. Para teste novo, use um número que ainda não tenha boas-vindas registradas nessa organização: repetir o cadastro não dispara nova mensagem.

Se não chegar, confira a sessão no painel e os logs do backend. O guia [WHATSAPP.md](WHATSAPP.md) descreve os estados PENDING, FAILED, UNKNOWN e SENT. Não reenvie automaticamente mensagens UNKNOWN sem conferir o envio no WAHA.

## Manutenção

Depois do primeiro teste bem-sucedido, registre o digest instalado e substitua o valor de `WAHA_IMAGE` no `.env` por esse digest:

```bash
sudo docker image inspect devlikeapro/waha:latest --format '{{index .RepoDigests 0}}'
```

Assim, atualizações ficam intencionais. Preserve os volumes e mantenha backup da configuração e do armazenamento de sessão, com acesso restrito. Para consultar consumo: `sudo docker stats --no-stream`. Para reiniciar os serviços: `sudo docker compose restart`.

Fontes: [VPS da OVH](https://www.ovhcloud.com/en/vps/), [SSH e primeiro acesso](https://support.us.ovhcloud.com/hc/en-us/articles/360009253639-Getting-started-with-a-VPS), [Docker no Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Caddy e HTTPS](https://caddyserver.com/docs/automatic-https), [WAHA](https://waha.devlike.pro/docs/how-to/install/).
