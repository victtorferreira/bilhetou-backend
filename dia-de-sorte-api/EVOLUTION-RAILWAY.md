# Evolution API no Railway

Integração com Evolution API 2.x, conexão `WHATSAPP-BAILEYS`. O backend mantém a fila `WhatsappWelcome`, consentimento, texto e prevenção de duplicatas. Não há migração nova do Bilhetou. A infraestrutura remota e um envio real ainda precisam ser validados.

Referências verificadas: [release 2.3.7](https://github.com/evolution-foundation/evolution-api/releases/tag/2.3.7), [Docker Compose oficial](https://github.com/evolution-foundation/evolution-api/blob/main/docker-compose.yaml), [variáveis da versão 2.3.7](https://github.com/evolution-foundation/evolution-api/blob/2.3.7/.env.example). Baileys é uma conexão por WhatsApp Web; trocar de software não garante estabilidade da conexão.

## 1. Pausar os envios durante a troca

Em **bilhetou-backend → Variables**, configure `WAHA_ENABLED=false` e aplique o deploy. Aguarde o deployment antigo encerrar antes de ativar o outro provedor. Se Evolution já estiver selecionada, pause com `WHATSAPP_ENABLED=false`.

O cadastro continua criando mensagens autorizadas na fila. Não apague a tabela nem o volume do WAHA. Deixe o WAHA disponível para consultar eventuais envios de resultado incerto.

## 2. Publicar o backend

Na raiz do repositório backend, publique os arquivos desta implementação na branch usada pelo Railway. Confira **bilhetou-backend → Settings → Source**: se acompanhar `main`, alterações publicadas apenas em `migracao-railway` não entrarão em produção. O deploy deve conter `whatsappConfig` e as rotas Evolution no serviço de boas-vindas.

## 3. Criar os serviços de infraestrutura

### Ajuste para o limite do plano Free

Se a criação da Evolution falhar com `Free plan resource provision limit exceeded`, não crie novos bancos ou projetos para tentar resolver. Para esta instalação com uma réplica, substitua o Redis recém-criado pela Evolution: remova somente o serviço `evolution-redis` que ainda não atende nenhuma aplicação e tente criar a Evolution novamente. A liberação depende dos limites efetivos da conta; se continuar bloqueado, confira os recursos existentes e o painel de uso antes de remover qualquer outro serviço.

A versão 2.3.7 permite cache local. Nesse caso, no modelo de variáveis abaixo, substitua a configuração Redis por:

```dotenv
CACHE_REDIS_ENABLED=false
CACHE_LOCAL_ENABLED=true
CACHE_REDIS_SAVE_INSTANCES=false
DATABASE_SAVE_DATA_INSTANCE=true
```

Remova `CACHE_REDIS_URI` e sua referência ao serviço excluído. Use apenas uma réplica; o cache local se perde a cada reinício, mas a autenticação permanece no `evolution-db`. Se o projeto já atingiu o limite de volumes, não adicione outro volume à Evolution neste modo de autenticação persistida no Postgres. Preserve os volumes do Bilhetou, do WAHA e do `evolution-db`.

O restante desta seção descreve a opção com Redis, quando houver capacidade na conta.

No mesmo projeto e ambiente do backend:

1. **New → Database → PostgreSQL**. Renomeie o novo serviço para **evolution-db**. Este é um banco novo; não altere o `DATABASE_URL` do Bilhetou.
2. **New → Database → Redis**. Renomeie para **evolution-redis**. Mantenha o volume persistente criado pelo template.
3. **New → Docker Image**: `evoapicloud/evolution-api:v2.3.7`. Renomeie para **evolution**. Se a imagem não for reconhecida, confira o nome e a tag no registro oficial; não escolha uma imagem de terceiro aleatória.
4. No serviço Evolution, anexe um volume em **`/evolution/instances`**. Não reutilize o volume do WAHA.
5. Use a mesma região do backend, uma réplica e execução contínua, sem suspensão por inatividade. Esses serviços adicionais consomem recursos e créditos do Railway.

## 4. Configurar a Evolution

Abra **evolution → Variables → Raw Editor** e use [deploy/railway/evolution.env.example](deploy/railway/evolution.env.example).

- Gere uma chave nova, diferente da chave WAHA exposta anteriormente. No PowerShell: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Guarde o resultado como `AUTHENTICATION_API_KEY`; não compartilhe a chave.
- As referências `${{evolution-db.DATABASE_URL}}` e `${{evolution-redis.REDIS_URL}}` dependem dos nomes exatos dos serviços. Use URLs internas.
- Não copie as variáveis `WAHA_*` para a Evolution.
- Em **Settings → Networking → Generate Domain**, publique a porta **8080**. Copie o domínio HTTPS para `SERVER_URL`, sem `/manager` no final, e aplique o deploy.
- Preserve o comando padrão da imagem. Não configure os comandos Prisma do Bilhetou nem seu healthcheck `/api/health` neste serviço. A imagem gerencia o próprio banco.
- Confira os logs: conexão com banco e Redis deve estar funcionando e a API deve responder na porta 8080.

Com `DATABASE_SAVE_DATA_INSTANCE=true` e `CACHE_REDIS_SAVE_INSTANCES=false`, a autenticação da instância é persistida no Postgres da Evolution. O volume é adicional, não substitui backup do banco. A fila de mensagens do Bilhetou continua no Postgres original e não depende deste Redis.

## 5. Criar e conectar a instância

Acesse `https://SEU-DOMINIO/manager`. Informe a URL raiz do servidor e a chave nova. Crie a instância **bilhetou**, com integração **WHATSAPP-BAILEYS**, e abra o QR Code. No celular, use WhatsApp → Aparelhos conectados → Conectar aparelho.

Caso o Manager não esteja disponível na imagem, use um cliente REST (por exemplo Postman), com o header `apikey` e `Content-Type: application/json`:

```http
POST /instance/create
```

```json
{"instanceName":"bilhetou","integration":"WHATSAPP-BAILEYS","qrcode":true}
```

Para obter outro QR: `GET /instance/connect/bilhetou`. Para conferir o estado: `GET /instance/connectionState/bilhetou`. Aguarde `instance.state` igual a **open**. Não crie a instância repetidamente. Se o QR ficar preso, obtenha os logs da tentativa antes de repetir resets.

## 6. Selecionar Evolution no Bilhetou

Somente com a instância conectada e o novo código publicado, configure **bilhetou-backend → Variables**:

```dotenv
WHATSAPP_PROVIDER=evolution
WHATSAPP_ENABLED=true
WAHA_ENABLED=false
EVOLUTION_BASE_URL=http://evolution.railway.internal:8080
EVOLUTION_API_KEY=${{evolution.AUTHENTICATION_API_KEY}}
EVOLUTION_INSTANCE=bilhetou
```

No painel, valores simples ficam sem aspas. A URL interna acima depende do serviço se chamar `evolution`. A chave permanece apenas no backend e na Evolution; nunca na Vercel ou em variáveis `VITE_*`. Aplique o deploy e aguarde a conclusão.

Só um provedor é escolhido por processo. Não mantenha dois deployments do backend com provedores diferentes ativos durante a troca. Não há fallback automático para WAHA após erro de envio, pois isso poderia duplicar mensagens.

## 7. Testar e acompanhar

Faça um cadastro autorizado com um número de teste sob seu controle. A fila deve passar de `PENDING` para `SENT` e a mensagem deve aparecer no telefone. `SENT` significa aceite com ID pelo provedor, não confirmação de entrega. Nenhuma mensagem real foi enviada pelos testes automatizados.

```sql
SELECT "id", "status", "attempts", "nextAttemptAt", "lastError"
FROM "WhatsappWelcome"
ORDER BY "consentedAt" DESC LIMIT 10;
```

O backend usa `GET /instance/connectionState/{instance}`, `POST /chat/whatsappNumbers/{instance}` e `POST /message/sendText/{instance}`, autenticados pelo header `apikey`. A consulta retorna o JID canônico, inclusive `@lid`. O ID do envio vem de `key.id`.

Falhas antes do envio podem ser repetidas até dez tentativas. A consulta de contato tem limite de 60 segundos; a consulta de estado e o envio têm limite de 10 segundos cada. O orçamento de 80 segundos fica abaixo da expiração de reserva de dois minutos. Resultados incertos de envio ficam `UNKNOWN`, sem reenvio automático. Logs registram apenas ID interno e códigos de erro, como `SESSION_NOT_WORKING`, `CONTACT_TIMEOUT` ou `CONTACT_HTTP_401`.

Mensagens `PENDING` continuam com a mesma contagem de tentativas e agendamento. `FAILED`, `UNKNOWN`, `SENT` e `EXPIRED` não são reabertas na troca. Pendências com consentimento de mais de 24 horas expiram. Não resete todos os estados para tentar enviar novamente; confira cada resultado incerto no provedor usado anteriormente.

Após confirmar o recebimento e a reconexão após um reinício controlado, suspenda o serviço WAHA. Para voltar: pause Evolution (`WHATSAPP_ENABLED=false`), finalize o deployment, confira a sessão WAHA e selecione `WHATSAPP_PROVIDER=waha`, `WAHA_ENABLED=true` com as credenciais válidas do WAHA. A fila permanece a mesma.
