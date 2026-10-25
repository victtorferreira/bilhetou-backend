# Checkout Pix Zettpay

Implementação baseada no arquivo `zettpay-llms.txt` fornecido pelo usuário e no exemplo de `POST /transactions` enviado na conversa. A API documentada é `https://api.zettpay.io/api`, com OAuth por `client_id`/`client_secret`, valores em reais e `Idempotency-Key` obrigatória na criação de cobranças.

## Escopo e estado da implantação

O checkout público do Bilhetou passa a gerar cobrança para o pedido quando `ZETTPAY_ENABLED=true`. O cliente informa e-mail e CPF/CNPJ na etapa de pagamento; o nome vem da sessão e o valor vem exclusivamente do pedido no servidor. São exibidos QR Code e Pix Copia e Cola, com consulta manual e automática a cada dez segundos enquanto a página está aberta. A confirmação também funciona por webhook, com a página fechada.

Não há cash-out, saques, transferências, assinaturas recorrentes ou pré-aprovações nesta implementação. As rotas `/pix/pay` e `/pix/pay-pre-approval` enviam dinheiro ou bloqueiam saldo; não são utilizadas para receber os pagamentos do checkout.

**Contrato de confirmação validado:** o exemplo de `GET /transactions/lookup` fornecido pelo usuário confirma o status de cash-in pago como **`approved`**, em minúsculas. Configure `ZETTPAY_PAID_STATUS=approved`. A criação começa em `pending`; o backend só confirma o pedido quando a consulta autenticada retorna `approved` e os identificadores e o valor correspondem ao pagamento local. Os testes usam esse mesmo contrato, incluindo valores em string decimal e ID externo alfanumérico.

A implantação no Railway, a migração do banco e uma validação real com a conta aprovada ainda dependem da configuração do operador. O código pode ser publicado desativado até concluir as credenciais e o webhook.

## 1. Publicar e aplicar migração

Publique as alterações nos dois repositórios, nas branches que Railway e Vercel acompanham. O backend deve incluir `prisma/schema.prisma`, `prisma/migrations/202610250001_zettpay_checkout`, `src/payments/zettpay.*`, as alterações nos serviços de participantes, `src/app.module.ts`, os testes e esta documentação. O frontend inclui rota de pagamento, serviços, tipos, confirmação, área do participante e a indicação de pagamento no admin.

O Dockerfile já gera o cliente Prisma. Mantenha `npm run prisma:deploy` como pre-deploy no Railway. A migração adiciona os campos `Order.paymentRequired`/`paymentStatus` e a tabela `ZettpayPayment`. Não apaga ou cobra pedidos existentes. A tabela `PaymentWebhookEvent`, criada pela migração anterior de pagamentos Pix, é reutilizada com prefixo próprio para os eventos Zettpay.

## 2. Credenciais e webhook assinado

No painel Zettpay, obtenha `client_id` e `client_secret` com acesso à criação e consulta de cobranças. Não coloque credenciais no frontend/Vercel nem as compartilhe em chats ou prints.

Cadastre um webhook para a URL:

```text
https://bilhetou-backend-production.up.railway.app/api/payments/zettpay/webhook
```

Guarde o `signing_secret` **emitido pela Zettpay**, incluindo `whsec_`. Não invente esse segredo localmente. O contrato fornecido diz que ele aparece uma única vez em `POST /webhooks`; se o webhook já existia sem assinatura, use a rotação do segredo no painel ou `POST /webhooks/{id}/rotate-secret` (invalida o anterior imediatamente).

Se o painel não oferecer a criação, no cliente REST use:

1. `POST https://api.zettpay.io/api/oauth/token`, JSON com `client_id` e `client_secret`.
2. Copie o `access_token` para o header `Authorization: Bearer ...`.
3. `POST https://api.zettpay.io/api/webhooks`, JSON `{"url":"https://bilhetou-backend-production.up.railway.app/api/payments/zettpay/webhook"}`.
4. Guarde o `signing_secret` retornado. Não crie repetidamente webhooks iguais; consulte `GET /webhooks` para verificar os existentes.

O backend exige `X-Webhook-Signature: t=<unix>,v1=<hex>`. Calcula HMAC-SHA256 com o `signing_secret` sobre `<t>.<corpo bruto>`, compara em tempo constante e aceita somente timestamps dentro de cinco minutos. O Nest já está configurado com `rawBody: true`.

## 3. Variáveis no bilhetou-backend

```dotenv
ZETTPAY_ENABLED=false
ZETTPAY_CLIENT_ID=SEU_CLIENT_ID
ZETTPAY_CLIENT_SECRET=SEU_CLIENT_SECRET
ZETTPAY_WEBHOOK_SIGNING_SECRET=whsec_SEGREDO_EMITIDO_PELA_ZETTPAY
ZETTPAY_PAID_STATUS=approved
```

Substitua os placeholders de credenciais e assinatura pelos valores reais. Mantenha `ZETTPAY_PAID_STATUS=approved`, sem aspas. Após configurar o webhook e aplicar a migração, altere `ZETTPAY_ENABLED=true` e aplique o deploy. O formulário só deve ser utilizado após a migração e a configuração correta.

A Zettpay é o único gateway de pagamento integrado na aplicação. Não é necessário instalar outro serviço, Redis ou banco. As migrações históricas e a tabela de registros financeiros anteriores são preservadas, sem rotas ou serviços de outro gateway. O controle de eventos de webhook continua sendo usado pela Zettpay.

## 4. Primeiro teste real

1. Crie um novo pedido com um número sob seu controle. Pedidos antigos não são cobrados retroativamente.
2. Ao confirmar os bilhetes, o site abre `/pagamento/{orderId}`.
3. Informe seu e-mail e CPF/CNPJ válidos. O backend valida os dígitos verificadores e usa o nome da sessão como nome do pagador.
4. Gere o Pix, confira valor e recebedor no aplicativo do banco e pague uma cobrança de baixo valor.
5. Aguarde a confirmação ou clique Consultar pagamento. Os bilhetes aparecem na área do participante após `Order.paymentStatus=PAID`.
6. Confira também o webhook no painel Zettpay e o estado do pagamento no Postgres do Bilhetou. O admin de participantes passa a mostrar Pago para pedidos confirmados.

```sql
SELECT p."id", p."orderId", p."amountCents", p."status",
       p."providerStatus", p."paidAt", p."lastError",
       o."paymentStatus"
FROM "ZettpayPayment" p
JOIN "Order" o ON o."id" = p."orderId"
ORDER BY p."createdAt" DESC LIMIT 10;
```

Essa consulta não exibe e-mail nem documento do pagador. Os testes automatizados usam respostas simuladas; não houve cobrança ou envio de credenciais à conta real durante a implementação.

## Idempotência, conferência e recuperação

- Uma cobrança local por pedido, garantida por índice único antes do POST externo. A chave externa é `bilhetou-{payment.id}` e o `external_id` é esse mesmo ID local, sem o prefixo.
- O valor é armazenado em centavos no banco e convertido para reais para a API. A resposta é convertida com duas casas, sem aceitar arredondamentos ambíguos. Taxa (`fee`) não substitui o valor bruto do pedido na conferência.
- A resposta só é aceita se ID externo, `external_id`, moeda quando presente e valor corresponderem ao registro local. `processing`, `pending` ou corpo enviado pelo cliente nunca confirmam recebimento.
- Timeout, reinício ou resposta ambígua deixam a cobrança em conferência. Consultas posteriores usam `GET /transactions/lookup?external_id=...`, inclusive para recuperar um ID externo que não chegou a ser salvo. Não há repetição automática do POST nem criação de outra cobrança para o mesmo pedido.
- Webhook de `type: cashin` é autenticado e provoca nova consulta à API. Os dados do webhook não são usados como prova isolada de pagamento. Webhooks de cash-out e recorrência são ignorados.
- Duplicatas de webhook são identificadas pelo hash do corpo assinado. Pagamento e pedido são atualizados juntos em transação com bloqueio do registro; mensagens atrasadas não rebaixam um pagamento confirmado.
- OAuth é mantido apenas na memória do backend, renovado por expiração/401, com uma única autenticação concorrente. Erros retornam códigos controlados, sem corpos privados do provedor.
- CPF/CNPJ e e-mail são enviados à Zettpay para gerar a cobrança, mas não são gravados na tabela local de pagamentos. Documento não fica em localStorage. O retorno ao navegador não contém o documento ou as credenciais.
- As rotas de pagamento usam a sessão HttpOnly do participante, verificam o proprietário do pedido, validam JSON/origem e retornam `Cache-Control: private, no-store`.

## Estoque e prazo do Pix

O fluxo existente vincula os bilhetes ao pedido e os deixa indisponíveis para outra pessoa. Nesta integração, os novos pedidos com pagamento obrigatório só exibem os bilhetes na área do participante após o recebimento confirmado. O vínculo no banco não equivale a uma venda paga; a indicação financeira vem de `paymentStatus`.

A documentação fornecida não declara um campo de validade/cancelamento da cobrança avulsa. Portanto, não existe liberação automática dos bilhetes por um temporizador local, pois isso poderia revender um bilhete cujo Pix ainda aceita pagamento. Peça à Zettpay as regras/rotas de expiração e cancelamento para implementar abandono de pedidos com liberação segura do estoque. Não altere manualmente bilhetes de uma cobrança ativa sem confirmar o cancelamento no provedor.

Pedidos anteriores à ativação mantêm `paymentRequired=false` e o comportamento anterior, sem alegar pagamento. Desativar `ZETTPAY_ENABLED` interrompe novas cobranças, consultas e webhooks: deixe a integração ativa enquanto houver cobranças abertas ou faça a conciliação antes de pausar. O prazo original da sessão do participante continua sendo de 24 horas; a conferência financeira via webhook independe da sessão, mas acesso posterior aos bilhetes depende da estratégia de autenticação do sistema.

## Limites desta entrega

### Diagnóstico de divergência da transação

`ZETTPAY_TRANSACTION_MISMATCH` significa que a resposta recebida não corresponde aos dados esperados; não significa necessariamente pagamento recusado. O QR pode ter sido criado corretamente e a divergência aparecer apenas na consulta. O backend registra uma linha com ID local e nomes controlados dos campos, sem dados pessoais, credenciais ou corpo completo da resposta:

```text
ZETTPAY_TRANSACTION_MISMATCH pagamento=<id local> campos=id_divergente
```

Os códigos possíveis são `id_invalido`, `id_divergente`, `referencia_divergente`, `valor_divergente`, `moeda_divergente`, `status_invalido` e `id_webhook_divergente`. A resposta HTTP apresenta uma mensagem compreensível e o código/campos para diagnóstico. Não remova a conferência de valor ou referência para contornar o erro; compare a criação e a consulta antes de adaptar qualquer mapeamento de identificadores. Um pagamento já efetuado não deve ser repetido para resolver falha de conciliação.

Não inclui estorno, chargeback, assinatura, saque, comunicação de pagamento por WhatsApp, atualização de regras de premiação ou restauração de conta pelo telefone. A conferência de sorteio existente continua uma observação administrativa e não passa a autorizar prêmios apenas porque um Pix foi pago.
