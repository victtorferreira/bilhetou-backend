# Cobranças Pix avulsas com AbacatePay

Página administrativa: `/admin/pagamentos`. Permite informar a descrição do produto/serviço e valor em reais, gerar um Pix com validade de 15 minutos, copiar o código e consultar a confirmação. O histórico das últimas 50 cobranças permanece no Postgres do Bilhetou. Funciona com sandbox e produção, conforme configuração exclusivamente no backend.

As cobranças são independentes dos bilhetes e pedidos de sorteio existentes: não reservam estoque, não mudam o estado de pedidos, não entregam produtos nem disparam WhatsApp. Não há checkout público, catálogo, carrinho, cartão, saque, estorno automático ou cálculo de frete nesta etapa. A descrição deve corresponder à operação real; não use uma descrição genérica para ocultar a venda de bilhetes. O módulo é a base de cobranças avulsas para a loja ainda em definição.

## Antes de receber de verdade

A [documentação de produção](https://docs.abacatepay.com/pages/production) exige conta e projeto aprovados, CNPJ e dados do negócio. Estar com a loja em desenvolvimento não elimina essa exigência. O AbacatePay [informa que não atende rifas ou sorteios](https://www.abacatepay.com/why). As cobranças reais aqui se destinam ao produto/serviço permitido que você definir para a loja.

Não houve chamada à conta do usuário, criação de cobrança real ou alteração de dados remotos durante a implementação. Ativar produção ainda depende das credenciais, da aprovação do provedor, do deploy e da configuração do webhook.

## 1. Publicar backend e aplicar migração

Publique os dois repositórios nas branches conectadas a Railway e Vercel. No backend, inclua `prisma/schema.prisma`, `prisma/migrations/202610230001_pix_payments`, os arquivos `src/payments`, `src/app.module.ts`, `src/main.ts`, os testes e os exemplos/documentação. Não publique `.env` ou chaves.

A nova migração cria apenas `PixPayment` e `PaymentWebhookEvent`, sem alterar pedidos ou participantes. No Railway, o comando de pre-deploy deve continuar `npm run prisma:deploy`. O Dockerfile já gera o Prisma Client no build. Para implantação manual: `npm run prisma:generate`, `npm run prisma:deploy`, `npm run build`. Não use `prisma migrate reset` em produção.

## 2. Configurar o backend

Em **bilhetou-backend → Variables**, para produção:

```dotenv
ABACATEPAY_ENABLED=true
ABACATEPAY_ENVIRONMENT=production
ABACATEPAY_API_KEY=abc_prod_SUA_CHAVE_PRIVADA_APROVADA
ABACATEPAY_WEBHOOK_SECRET=SEU_SEGREDO_ALEATORIO_COM_PELO_MENOS_32_CARACTERES
```

Gere o segredo com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Mantenha-o diferente da chave de API. A chave precisa das permissões `TRANSPARENT:CREATE` e `TRANSPARENT:READ`. O módulo aceita os prefixos `abc_prod_` e `prod_` para produção, `abc_dev_` e `dev_` para sandbox, rejeitando chave de ambiente diferente.

Para testar este módulo com cobranças persistidas sem dinheiro real, use `ABACATEPAY_ENVIRONMENT=sandbox` e uma chave de desenvolvimento. Essas variáveis são independentes de `ABACATEPAY_SANDBOX_*`, usadas pela tela antiga de teste fixo de R$ 2,00. Nunca use prefixo `VITE_` para chaves privadas nem as coloque na Vercel.

Para pausar novas cobranças e consultas ao provedor, defina `ABACATEPAY_ENABLED=false`; o histórico continua acessível para administradores. Isso também pausa o processamento de webhook; as retentativas do provedor são limitadas, então confira as cobranças pendentes quando reativar.

## 3. Cadastrar webhook no AbacatePay

No ambiente **Produção** do painel AbacatePay, abra **Integração → Webhooks** e cadastre:

- Nome: `Confirmação Pix da loja`.
- URL: `https://bilhetou-backend-production.up.railway.app/api/payments/abacatepay/webhook`.
- Secret: o mesmo valor de `ABACATEPAY_WEBHOOK_SECRET` do Railway.
- Evento: `transparent.completed`.
- Formato/API: v2, se houver opção de versão.

O AbacatePay acrescenta o parâmetro `webhookSecret` à URL e envia `X-Webhook-Signature`. O backend valida o segredo privado por comparação de hashes em tempo constante e a assinatura HMAC sobre o corpo original. A chave pública de integridade é a publicada na [documentação de segurança](https://docs.abacatepay.com/pages/webhooks/security); ela não substitui o segredo privado. Não copie URLs com o secret para prints ou chats.

O evento é apenas um aviso: o backend extrai o identificador Pix e confirma o estado na API autenticada antes de atualizar o banco. Eventos de sandbox não confirmam cobranças reais. IDs de eventos processados ficam registrados para ignorar duplicatas; atualizações também são condicionais, de modo que respostas antigas de consulta não rebaixam `PAID` para pendente/expirado. Uma falha temporária retorna 5xx, permitindo a retentativa do AbacatePay. Eventos ainda sem cobrança local conhecida também retornam 503 (pode haver corrida com a gravação do ID do provedor).

Crie outro webhook no ambiente de teste se quiser validar sandbox. Um webhook de teste não recebe os eventos reais. Após trocar chave/ambiente, cobranças antigas continuam no histórico, mas só podem ser consultadas com credenciais do ambiente correspondente.

## 4. Operar

1. Entre em `https://bilhetou.vercel.app/admin/pagamentos` com a credencial administrativa habitual.
2. Confira o selo **PAGAMENTO REAL**.
3. Informe a descrição verdadeira do produto/serviço e um valor entre R$ 1,00 e R$ 10.000,00.
4. Clique **Gerar Pix real**. Isso cria uma cobrança real, mas o dinheiro só é movimentado quando alguém a paga.
5. Use o QR Code ou Copia e Cola para pagar uma cobrança sua de pequeno valor e conferir o fluxo. A tela real não oferece botão de simulação.
6. Clique **Consultar pagamento** para atualizar a tela. O webhook atualiza o banco mesmo com a página fechada; use Atualizar histórico/Abrir cobrança para ver o resultado depois.

Os códigos são exibidos apenas para administradores. Para cobrar um cliente, compartilhe o código Pix correspondente, não a credencial de administração. Um futuro checkout público deverá usar autenticação/referência própria e calcular o valor no servidor a partir do catálogo; não exponha as rotas de criação administrativa a visitantes.

## Criação e resultados incertos

Cada solicitação recebe `requestKey` e é gravada **antes** da chamada ao provedor. A chave única por organização impede dois POSTs externos ao repetir ou executar simultaneamente a mesma solicitação. Reusar a chave com descrição, valor ou ambiente diferente retorna conflito. O botão de repetição após erro de rede mantém a chave e os dados originais.

`CREATING` pode aparecer enquanto a chamada está em andamento. Se um processo for interrompido, esse registro é preservado e não é reenviado. Timeout, resposta inválida, erro do provedor ou falha local após criação podem deixar `UNKNOWN`. A referência local é enviada como `externalId` e `metadata.paymentId` no AbacatePay para permitir conferência no painel. Não gere outra cobrança sem conferir esse resultado; não há repetição automática do POST nem reconciliação automática de criações sem `providerId` persistido.

`PENDING` é cobrança gerada e não paga. `PAID` registra o aceite de pagamento pelo provedor. `EXPIRED`/`CANCELLED` vêm da consulta de status. O módulo não registra automaticamente reembolsos, disputas, frete ou entrega; acompanhe esses casos no painel do provedor. Um evento não recebido pode ser recuperado pelo botão de consulta, desde que o ID externo tenha sido salvo.

## Verificação

Os testes cobrem autenticação, valores, isolamento por organização/ambiente, criação concorrente com a mesma chave, resultado incerto sem reenvio, confirmação por consulta, assinatura/segredo de webhook e duplicação de evento. Testes de navegador verificam cobrança e consulta na interface real em desktop e celular com respostas simuladas. A integração com o banco de produção e o primeiro pagamento real devem ser validados no ambiente implantado.
