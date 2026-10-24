# Testar Pix com AbacatePay

Implementação administrativa em `/admin/pagamentos-teste`. Gera uma cobrança simulada fixa de **R$ 2,00**, mostra QR Code e Copia e Cola, consulta o status e permite simular o pagamento. Usa a API REST v2, sem SDK adicional. Não depende de outro banco, Redis ou serviço no Railway.

## Escopo

Este é um teste de comunicação do Bilhetou com a API sandbox, não um checkout de venda de bilhetes. Não altera `Order`, estoque, participantes, relatórios financeiros nem dispara mensagens de WhatsApp. O site público continua registrando pedidos sem confirmar pagamento. Não há endpoint de webhook nesta implementação; a confirmação é consultada pelo backend após a simulação ou pelo botão Consultar status. O sandbox não movimenta dinheiro: não abra o banco para pagar este QR.

O AbacatePay informa que não atende rifas e sorteios: [página oficial](https://www.abacatepay.com/why), [termos](https://www.abacatepay.com/termos). Esta implementação não habilita produção. Para pagamento real dos bilhetes, será necessário um provedor compatível com a operação e o fluxo completo de reserva, expiração, webhook autenticado e conciliação.

## 1. Criar uma chave de teste

No painel AbacatePay, mantenha **Modo Teste (Sandbox)** ligado. Abra **Integração → API** e crie uma chave para o teste do Bilhetou. Dê as permissões **TRANSPARENT:CREATE** e **TRANSPARENT:READ**. Não é necessário conceder saques, transferências, cartões ou permissões de produção.

O código aceita chaves privadas com prefixo `abc_dev_`, documentado na [página de produção](https://docs.abacatepay.com/pages/production), e `dev_`, usado no guia de sandbox. Não use a chave pública `pk_` de cartão. Se o painel emitir outro formato, confirme a versão da API antes de adaptar a validação; não compartilhe a chave no chat.

Para cobranças avulsas reais de produtos ou serviços, consulte [ABACATEPAY-PIX.md](ABACATEPAY-PIX.md). A tela sandbox permanece separada.

## 2. Publicar

Há alterações nos dois repositórios: backend e frontend. Publique ambos nas branches acompanhadas por Railway e Vercel. Não há nova migração Prisma. Confira se o backend publicado contém `AbacatepaySandboxController` e se o frontend contém a rota `/admin/pagamentos-teste`.

## 3. Configurar somente o backend no Railway

Em **bilhetou-backend → Variables**:

```dotenv
ABACATEPAY_SANDBOX_ENABLED=true
ABACATEPAY_SANDBOX_API_KEY=dev_SUA_CHAVE_PRIVADA_DE_TESTE
```

Substitua pelo valor real, sem aspas, e aplique o deployment. Nunca coloque a chave na Vercel, no Git ou em variável `VITE_*`. A integração fica desativada por padrão. Não permite apontar a API para outra URL: utiliza somente `https://api.abacatepay.com/v2`.

## 4. Testar no Bilhetou

1. Entre na administração em `https://bilhetou.vercel.app/admin` usando a credencial administrativa habitual.
2. No menu, abra **Teste de pagamento Pix**.
3. Clique **Gerar Pix de teste de R$ 2,00**. Aguarde aparecer o QR e o status Aguardando simulação.
4. Clique **Simular pagamento** e aguarde **Pagamento simulado confirmado**. O backend consulta o status novamente após o POST; sucesso da chamada de simulação não é considerado confirmação por si só.
5. Consulte o painel sandbox do AbacatePay para comparar o registro.

O teste atual fica na memória da página, e desaparece ao recarregar. A cobrança continua no painel do AbacatePay. A referência de consulta é assinada, vinculada à organização e válida por 24 horas. Trocar a chave invalida as referências antigas. Não há histórico persistido no banco Bilhetou nem entrega de bilhetes neste teste.

## Erros

- **Desativado:** confira as variáveis e se o deploy terminou.
- **Chave recusada / 401:** confira a chave privada de sandbox ou gere outra se foi revogada.
- **Permissões / 403:** gere uma chave com `TRANSPARENT:CREATE` e `TRANSPARENT:READ`.
- **Timeout / erro de rede:** confira o painel AbacatePay antes de clicar novamente. Não existe repetição automática de criação ou simulação.
- **404 no Bilhetou:** confira a branch e o deploy dos dois repositórios.

As rotas ficam em `/api/admin/payments/abacatepay/sandbox` e exigem sessão administrativa. As ações de consulta e simulação aceitam apenas referências assinadas emitidas por este teste para a mesma organização. Respostas do provedor são validadas e erros não expõem a chave, dados privados nem o corpo completo da resposta. O código rejeita cobranças que não retornem `devMode: true` ou o valor esperado.

## Referências técnicas

- [Autenticação e permissões](https://docs.abacatepay.com/pages/authentication)
- [Criar Pix v2](https://docs.abacatepay.com/pages/transparents/create)
- [Consultar status](https://docs.abacatepay.com/pages/transparents/check)
- [Simular pagamento](https://docs.abacatepay.com/pages/transparents/simulate-payment)
- [Dev mode](https://docs.abacatepay.com/pages/devmode)

Os testes automatizados usam respostas simuladas e não chamam a conta do usuário. A validação com a chave real de sandbox depende da configuração no Railway.
