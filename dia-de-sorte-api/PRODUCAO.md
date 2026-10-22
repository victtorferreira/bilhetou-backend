# Publicação do Bilhetou

## Atualização de 22/10/2026

Os textos e fluxos demonstrativos foram retirados. Cadastro, seleção, pedidos, bilhetes, resultados e administração usam as entidades Participant, Order e o estado ASSIGNED. Um pedido registrado não é marcado como pago; o pagamento continua sem integração automática. O telefone permanece sem verificação de identidade.

A migração `202610220001_remove_demo_mode` renomeia tabelas e colunas preservando os dados e os vínculos. Apenas campanhas criadas pelos antigos scripts de preparação são marcadas como `legacySample`, arquivadas e retiradas do catálogo. Seus bilhetes e pedidos são mantidos no banco. Os nomes conhecidos de organizações criadas por esses scripts são atualizados para Bilhetou. Não há exclusão de participantes, pedidos ou números. Os históricos de conferência permanecem imutáveis.

As migrações antigas devem continuar no repositório: o Prisma usa seu histórico e checksums. As referências antigas contidas nelas não ativam um ambiente de testes. Rotas de sessão antigas são mantidas temporariamente apenas para migrar cookies de participantes existentes; o frontend usa `/api/participant`. A API antiga de atribuição anônima e a criação local sem autenticação foram removidas.

## 1. Render: atualizar o backend

Faça um backup antes de aplicar a migração. Envie as alterações do backend para o GitHub, incluindo a migração e as novas pastas `src/participants` e `src/security`.

Configure o serviço:

```text
Root Directory: dia-de-sorte-api
Build Command: npm ci --include=dev && npm run prisma:generate && npm run build
Start Command: npm run prisma:deploy && npm start
```

Remova o comando `setup:demo` do Start Command antes de publicar: ele não existe mais. Remova também as variáveis antigas `DEMO_SETUP_TICKETS` e `ENABLE_LOCAL_DEMO_TICKET_CREATION`, se existirem. Nenhum comando cria campanhas ou bilhetes automaticamente.

Mantenha as variáveis:

```dotenv
DATABASE_URL=<conexão interna do PostgreSQL>
NODE_ENV=production
NODE_VERSION=24
FRONTEND_ORIGIN=https://bilhetou.vercel.app
PUBLIC_ORGANIZATION_ID=<UUID atual da organização>
ADMIN_ORGANIZATION_ID=<mesmo UUID, para administrar esta organização>
ADMIN_ACCESS_KEY=<credencial administrativa aleatória, pelo menos 32 caracteres>
ADMIN_ACTOR=<identificação do administrador>
```

Não altere o UUID já utilizado. Se `PUBLIC_CAMPAIGN_ID` apontava para a campanha automática arquivada, remova essa variável ou substitua pelo UUID de uma campanha real aberta. Sem essa variável, o site utiliza a primeira campanha aberta da organização.

A alteração de nomes de tabelas exige publicar o novo backend junto com a migração; pode haver uma breve interrupção enquanto a versão anterior é substituída. Esta alteração não foi aplicada ao banco externo pelo agente.

## 2. Cadastrar a campanha

Depois do deploy, entre em `/admin` com `ADMIN_ACCESS_KEY` e abra `/admin/campanhas`.

Cadastre o nome, valor do bilhete, prêmio opcional, encerramento opcional e status da campanha. Use status Aberta para disponibilizá-la ao cadastro público. Em `/admin/bilhetes`, gere os bilhetes; ou importe um CSV em `/admin/importacao`. Nada é inventado se prêmio ou data não forem informados: a tela exibe Não informado ou Data a definir.

Caso uma instalação nova ainda não tenha organização, configure `ORGANIZATION_NAME` e execute explicitamente `npm run organization:create`. Esse comando cria somente a organização configurada, sem campanhas ou bilhetes. Ele não é necessário para a organização já cadastrada no Render.

## 3. Vercel: atualizar o frontend

Envie o frontend atualizado para o GitHub. Mantenha `VITE_API_URL=/api` em Production e publique novamente. O `vercel.json` encaminha `/api/*` para `https://bilhetou-backend.onrender.com/api/*` antes do fallback de rotas React.

O caminho atual de confirmação é `/confirmar-pedido`; o endereço anterior `/pagamento` redireciona para ele. Os cookies permanecem HttpOnly e Secure em produção; uma transição da sessão antiga é realizada sem importar dados do navegador.

Verifique `https://bilhetou.vercel.app/api/participant/session`, depois o cadastro, a seleção e a confirmação. O resultado deve ser Pedido registrado, com pagamento não confirmado, nunca uma declaração automática de pagamento.

## Verificações

Execute `npm test` e `npm run build` em cada projeto. Os testes de banco exigem `TEST_DATABASE_URL` apontando para PostgreSQL descartável com todas as migrações aplicadas. Não use o banco de produção para os testes. Os testes automatizados foram mantidos; eles não disponibilizam dados fictícios no site.

Validação desta atualização: schema Prisma válido, builds do backend/frontend aprovados, 27 testes do backend e 7 do frontend aprovados, e 8 testes de navegador aprovados em celular e desktop. Os testes de navegador utilizam interceptações de API somente no processo de teste. Três testes de integração PostgreSQL ficaram pendentes por ausência de TEST_DATABASE_URL; a nova migração ainda precisa ser aplicada e verificada no ambiente de destino.
