# Bilhetou — backend NestJS + Prisma + PostgreSQL (MVP DEMO)

**Somente demonstração técnica.** Não cobra Pix, não vende rifas reais, não declara vencedores nem paga prêmios. O dado de R$ 2 é **ilustrativo**, em centavos (`200`). Regras e autorização de operação real precisam de revisão jurídica.

## Pré-requisitos

- Node.js 22+, npm e Docker com Compose
- Porta local 5432 livre

## Iniciar

```bash
cp .env.example .env
npm install
docker compose up -d
npx prisma migrate dev --name init
npx prisma generate
npm run import:demo
npm run start:dev
```

No Windows PowerShell, substitua `cp` por `Copy-Item .env.example .env`.

O comando `import:demo` imprime `campaignId`. Use-o nas chamadas abaixo.

## Endpoints

### Criação de bilhetes pelo painel Bilhetou

O painel frontend em `/admin/bilhetes` tem o destino **API local · PostgreSQL**. A criação de lotes no banco segue duas etapas: gerar uma prévia no servidor e confirmar exatamente os bilhetes dessa prévia. A prévia não reserva nem insere estoque.

1. Instale as dependências, configure `DATABASE_URL` em `.env` e prepare o banco conforme a seção Iniciar.
2. Execute `npm run import:demo`. O script agora marca a nova campanha com `rulesVersion: demo-v1`; campanhas antigas com `draft-v1` não são habilitadas automaticamente para geração.
3. Na configuração local `.env`, defina `ENABLE_LOCAL_DEMO_TICKET_CREATION=true` e `FRONTEND_ORIGIN=http://localhost:5173`.
4. Execute `npm run start:dev`. A API permanece vinculada a `127.0.0.1:3000`.
5. No frontend, abra `/admin/bilhetes`, selecione **API local · PostgreSQL**, escolha a campanha, informe quantidade/prefixo, gere a prévia e confirme o lote.

O estoque do PostgreSQL é exibido separadamente do estoque demonstrativo do navegador. O fluxo público do frontend continua local; esta alteração não conecta cadastro de participantes ou pedidos públicos ao banco.

Novas rotas, todas sob `/api/demo/ticket-batches`:

| Método | Caminho | Operação |
| --- | --- | --- |
| GET | `/campaigns` | Até 100 campanhas demo abertas/em rascunho |
| GET | `/campaigns/:campaignId/tickets?page=1&query=BIL` | Estoque paginado de 20 registros, com busca por serial |
| POST | `/preview` | Prévia de um lote com números gerados no servidor |
| POST | `/confirm` | Confirmação da referência assinada, com gravação transacional |

Corpo de `/preview`:

```json
{
  "campaignId": "UUID_DA_CAMPANHA",
  "quantity": 10,
  "prefix": "BIL",
  "uniqueNumbers": false
}
```

Corpo de `/confirm`: `{ "token": "REFERENCIA_DEVOLVIDA_PELA_PREVIA" }`. A API não aceita números ou seriais arbitrários na confirmação. A referência é assinada, expira em 15 minutos e é invalidada ao reiniciar a API. Não é um token de login.

Regras implementadas:

- 1 a 1.000 bilhetes por lote, até 5.000 bilhetes por campanha demonstrativa.
- Serial sequencial por prefixo/campanha, como `BIL-000001`, aproveitando a constraint única existente.
- Quatro números distintos por bilhete entre `0000` e `9999`, preservando zeros à esquerda, com `crypto.randomInt` do Node.js.
- Por padrão, números podem aparecer em bilhetes diferentes. `uniqueNumbers: true` exclui todos os números já existentes na campanha e impede repetição no lote. Se não houver números suficientes, retorna conflito.
- Confirmações travam a linha da campanha e verificam novamente status, prazo, limite, seriais e política de números antes de inserir bilhetes e números em uma transação.
- A repetição da mesma confirmação, enquanto válida, retorna o lote existente sem duplicar os registros. Prévias concorrentes podem receber os mesmos próximos seriais; se uma delas for confirmada, a outra recebe HTTP 409 e deve ser gerada novamente.
- Nenhuma alteração no schema Prisma foi necessária. O estoque aproveita `Ticket`, `TicketNumber` e as constraints existentes.

**Restrição da demonstração local:** as novas rotas retornam 404 por padrão e sempre em `NODE_ENV=production`. Quando habilitadas, aceitam somente conexão de loopback, origem configurada e POST JSON. Isso **não implementa autenticação administrativa**. Não publique essas rotas atrás de um proxy nem habilite o modo demo em ambiente acessível externamente. Para administração real, substitua o guard por autenticação e autorização no servidor, com isolamento por organização.

### Testes de criação

```bash
npm run build
npm test
```

O teste de integração PostgreSQL/HTTP só roda quando `TEST_DATABASE_URL` aponta explicitamente para um banco de testes descartável. Por exemplo, em PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres:SENHA_DE_TESTE@127.0.0.1:55432/bilhetou_ticket_tests'
npm test
```

As tabelas precisam existir nesse banco de testes. Use `DATABASE_URL` apontando para ele ao executar `prisma db push`; nunca use esse comando de preparação de testes contra um banco de produção. O teste cria sua própria organização e remove seus dados ao terminar. Verifica validação HTTP, prévia sem inserção, confirmação repetida, concorrência entre lotes, lote de 1.000 bilhetes e paginação do estoque.

```bash
curl http://localhost:3000/api/campaigns
curl -X POST http://localhost:3000/api/demo/orders \
  -H 'Content-Type: application/json' \
  -d '{"campaignId":"SUBSTITUA_UUID","quantity":2}'
curl http://localhost:3000/api/tickets/SUBSTITUA_TICKET_UUID
curl http://localhost:3000/api/draws/SUBSTITUA_UUID
```

`POST /api/demo/orders` não pede identidade e **não entrega comprovante privado de compra**: é um exemplo público de atribuição de estoque fictício. Não exponha essa API publicamente; para produção, implementar autenticação, rate limits, isolamento por organização, reserva de inventário, confirmações idempotentes, autoria de pedidos e controle de acesso ao bilhete.

## Arquivo de estoque

Formato CSV: `serial,n1,n2,n3,n4`. Cada número tem exatamente quatro caracteres, incluindo zeros à esquerda. O importador de demonstração cria uma organização e uma campanha nova a cada execução. Reimportações de produção exigirão processamento idempotente e validação do lote.

## Apuração simulada

A fonte e a transformação dos resultados oficiais da Loteria Federal **ainda não foram definidas**. O script abaixo aceita números fictícios de quatro dígitos, registra correspondências e **não homologa ganhadores**. Antes de executar, encerre a campanha alterando seu status de `OPEN` para `CLOSED` no banco de desenvolvimento.

```bash
npm run result:demo -- SUBSTITUA_CAMPAIGN_UUID EXEMPLO-001 8993 0001
```

Não confunda correspondência de números com apuração válida. Em produção, vincular a concurso oficial, preservar publicação de origem, regras versionadas, data de fechamento, elegibilidade e revisão.

## Próximos passos de produção

1. Login seguro e autorização por organização.
2. Importação de lotes com transação e hash, verificação de integridade, política de duplicatas.
3. Ledger/auditoria imutável de mudanças de bilhetes, campanhas, apurações e notificações.
4. Registro confiável da Loteria Federal e definição documentada dos quatro dígitos elegíveis.
5. Testes automatizados (concorrência, estoque, transações, autorização, CSRF/CORS, abusos).
6. Somente com enquadramento jurídico e autorização cabível, estudar provedores de pagamento e regulação.

## Atenção às premissas

- A foto mostra quatro números, mas não indica como os resultados federais se convertem em números elegíveis; a regra precisa ser documentada.
- A API inicial retorna informações públicas de demonstração e não implementa LGPD nem segurança pronta para produção.
- `SKIP LOCKED` serializa a atribuição concorrente de bilhetes ao mesmo tempo que mantém throughput.
