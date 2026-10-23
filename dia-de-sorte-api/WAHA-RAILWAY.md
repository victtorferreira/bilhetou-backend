# Ativar o WhatsApp do Bilhetou no Railway

A API e o PostgreSQL já estão no Railway. A integração de cadastro com consentimento e a fila `WhatsappWelcome` já existem no código publicado. Não é necessário reescrever o backend, reinstalar o banco, copiar dados do Render nem disponibilizar um webhook para o envio de boas-vindas. Este roteiro cria um terceiro serviço no mesmo projeto e ambiente: `waha`.

## 1. Criar o serviço pela imagem oficial

No projeto que já contém `bilhetou-backend` e `Postgres`, clique **+ New/Create → Docker Image**. Informe:

```text
docker.io/devlikeapro/waha:latest
```

Nomeie o serviço como `waha`. Use a mesma região do backend e uma única réplica. Este serviço usa o comando padrão da imagem; não copie os comandos Node, Prisma, Root Directory ou `/api/health` do backend. Deixe o healthcheck customizado vazio inicialmente e confirme o funcionamento pelo painel após o deploy. A tag `latest` é para a primeira instalação; registre e fixe o digest da imagem validada para controlar atualizações posteriores.

O serviço consome recursos e volume cobrados pelo Railway. Confira as estimativas e os limites na sua conta. A recomendação conservadora do WAHA é 2 CPUs e 4 GB RAM; uma sessão WEBJS pode consumir menos, mas limites pequenos podem provocar reinícios. Acompanhe Metrics. Desative suspensão por inatividade/serverless tanto no WAHA quanto no backend que processa a fila.

## 2. Gerar os segredos no computador

Execute o comando abaixo três vezes no seu terminal, guardando cada resultado separadamente:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Use os resultados como chave da API, senha do painel e senha do Swagger. Não envie esses valores no chat, não publique no Git e não use a credencial administrativa do Bilhetou como chave do WAHA.

## 3. Configurar as variáveis do serviço waha

Use os nomes e valores de `deploy/railway/waha.env.example`, substituindo os três placeholders pelos segredos gerados. O arquivo pode ser usado como referência para o Raw Editor do Railway, removendo os comentários se necessário. Não crie uma chave diferente no backend: depois ele usará uma referência ao valor do serviço `waha`.

`PORT` e `WHATSAPP_API_PORT` ficam ambos em `3000`. O `WAHA_WORKER_ID` deve permanecer `bilhetou-railway` entre deploys. O QR não será impresso nos logs. As três credenciais devem ser configuradas antes de disponibilizar o serviço publicamente.

## 4. Adicionar armazenamento persistente

Crie um volume conectado ao serviço `waha`, com o mount path:

```text
/app/.sessions
```

Esse volume é exclusivo do WAHA; mantenha o volume do Postgres como está. A sessão do WhatsApp ficará nesse armazenamento. Sem o volume, um novo deploy pode exigir novo pareamento. Configure o volume antes do primeiro QR Code.

## 5. Fazer deploy e abrir o painel

Faça o deploy do WAHA e confira os logs. Em **Settings → Networking → Generate Domain**, gere o domínio HTTPS com target port **3000**. Abra:

```text
https://DOMINIO-DO-WAHA.up.railway.app/dashboard
```

Use usuário `admin` e `WAHA_DASHBOARD_PASSWORD`. Se o painel pedir conexão/API Server, informe a raiz HTTPS desse domínio, sem `/dashboard` ou `/api`, e o valor de `WAHA_API_KEY`. O navegador precisa do endereço público; ele não alcança o domínio `railway.internal`.

O domínio não é o do backend. A API WAHA tem autenticação por chave e o painel tem senha separada. Confira que uma janela anônima pede login antes de acessar o painel. Preserve o acesso às credenciais no gerenciador de senhas.

## 6. Conectar o número

No painel WAHA, crie ou inicie a sessão **default** (se já existir, use a existente). Abra o QR Code e escaneie no celular remetente em **WhatsApp → Aparelhos conectados → Conectar aparelho**. Aguarde **WORKING**.

Antes de habilitar os envios, reinicie somente o serviço WAHA e confira se a sessão volta para WORKING sem um novo QR. Isso valida o volume e a restauração da sessão. Se falhar, verifique mount path e worker ID antes de prosseguir.

## 7. Ligar o backend ao WAHA

No serviço **bilhetou-backend → Variables**, configure inicialmente:

```dotenv
WAHA_ENABLED=false
WAHA_BASE_URL=http://waha.railway.internal:3000
WAHA_API_KEY=${{waha.WAHA_API_KEY}}
WAHA_SESSION=default
```

Confira o domínio privado real em Settings/Networking do serviço WAHA. Se o nome/domínio for diferente, ajuste o endereço e a referência acima. Os serviços precisam estar no mesmo projeto e ambiente. O tráfego interno do Railway usa sua rede privada; o público HTTPS continua disponível para o painel. Se a conexão privada não funcionar, confira DNS e disponibilidade do serviço; como alternativa, use a raiz HTTPS pública do WAHA, mantendo a autenticação por chave.

Com sessão WORKING e variáveis conferidas, altere **WAHA_ENABLED=true**, aplique o deploy do backend e acompanhe seus logs. Não coloque essas variáveis no frontend/Vercel. A raiz da URL não deve terminar em `/api` ou `/dashboard`. Os valores booleanos da integração são sensíveis a maiúsculas: no backend, use exatamente `true`.

Ao habilitar, a fila poderá enviar confirmações autorizadas ainda pendentes das últimas 24 horas. Cadastros sem autorização não geram mensagem. Pendências mais antigas expiram. Não apague registros para forçar testes ou reenvios.

## 8. Testar pelo site

Abra o site atualizado numa janela anônima, informe um nome completo e outro WhatsApp sob seu controle (diferente do número remetente), marque a autorização e conclua o cadastro. É preciso ter uma campanha aberta. Use um número que ainda não tenha confirmação registrada nessa organização: o controle de duplicidade é por organização e telefone, mesmo se você fizer outro cadastro.

O worker consulta a fila a cada 5 segundos, resolve o identificador do número com o WAHA e solicita o envio. `SENT` significa que o WAHA aceitou e retornou um ID; confirme também no celular destinatário. O WhatsApp continua sem verificação de identidade por código.

Para acompanhar no Postgres sem mostrar contatos:

```sql
SELECT "status", COUNT(*) FROM "WhatsappWelcome" GROUP BY "status";
SELECT "id", "status", "attempts", "lastError", "providerMessageId"
FROM "WhatsappWelcome" ORDER BY "consentedAt" DESC LIMIT 20;
```

`PENDING` aguarda envio/consulta, `FAILED` indica falha definitiva ou tentativas esgotadas, `UNKNOWN` exige conferir o resultado no WAHA antes de qualquer reenvio. Não existe repetição automática de uma tentativa cujo resultado de envio é incerto. Veja [WHATSAPP.md](WHATSAPP.md).

## Pausar

Defina `WAHA_ENABLED=false` no backend e aplique o deploy. Isso interrompe o worker depois de sua tentativa em andamento; a autorização e a fila permanecem no banco. Não exclua o volume do WAHA para pausar o envio.

Fontes: [Docker no Railway](https://docs.railway.com/guides/docker-compose), [volumes](https://docs.railway.com/volumes), [rede privada](https://docs.railway.com/networking/private-networking), [configuração do WAHA](https://waha.devlike.pro/docs/how-to/config/), [segurança](https://waha.devlike.pro/docs/how-to/security/), [painel](https://waha.devlike.pro/docs/how-to/dashboard/).
