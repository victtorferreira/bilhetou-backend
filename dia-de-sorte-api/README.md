# Bilhetou — API

NestJS, Prisma e PostgreSQL. Veja [PRODUCAO.md](PRODUCAO.md) para publicar no Render e conectar o frontend na Vercel.

## Execução local

Copie `.env.example` para `.env`, configure a conexão PostgreSQL e as variáveis da organização e do administrador. No PowerShell, use npm.cmd/npx.cmd quando necessário.

```bash
npm install
docker compose up -d
npm run prisma:deploy
npm run prisma:generate
npm run start:dev
```

Para banco criado antes do histórico de migrações, audite os dados e registre a baseline antes de aplicar as migrações, conforme o guia de exclusividade do workspace. Não use db push para substituir as migrações: os checks e triggers de exclusividade estão no SQL complementar.

A aplicação ouve em 0.0.0.0 e usa a variável PORT, com padrão 3000. As rotas ficam sob /api. O cadastro público usa PUBLIC_ORGANIZATION_ID e o painel exige autenticação administrativa. Cada campanha aceita até 2.500 bilhetes com quatro números exclusivos.

## Comandos

- `npm run organization:create`: cria explicitamente a organização configurada em PUBLIC_ORGANIZATION_ID/ORGANIZATION_NAME, quando ainda não existe.
- `npm run tickets:audit`: auditoria de exclusividade sem alterar os dados.
- `npm run result:register`: registra resultados pelo operador. Correspondências não autorizam pagamentos de prêmios.
- `npm run build`: compila a API.
- `npm test`: verifica validações, isolamento, exclusividade, sessões e pedidos. Testes de PostgreSQL exigem TEST_DATABASE_URL para banco descartável.

## Comportamento dos pedidos

A confirmação vincula os bilhetes ao participante com uma transação e chave idempotente. A seleção não reserva estoque; conflitos são rejeitados. O estado ASSIGNED significa atribuído. Não há integração automática de pagamentos, comprovação de pagamento ou verificação de identidade por telefone.

Os dados de preparação anteriores são arquivados pela migração de transição e não entram no catálogo ou nos novos pedidos. Nenhum script cria estoque automaticamente durante a inicialização.
