# WAHA no Render

Configuração preparada, ainda não publicada. Nenhum serviço foi criado, nenhum plano foi contratado e nenhum número foi conectado.

## Recursos e custo para revisar antes de criar

O arquivo `../render.waha.yaml` descreve apenas um novo Web Service `bilhetou-waha`, executando a imagem pública `docker.io/devlikeapro/waha:latest`. Não importa nem altera os serviços existentes do backend e banco.

O plano `2c-4g` tem 2 CPUs e 4 GB de RAM, conforme a recomendação conservadora do [WAHA](https://waha.devlike.pro/docs/overview/faq/#system-requirements). Pela [tabela do Render](https://render.com/pricing), consultada em 22/10/2026, custa US$ 85/mês. O disco de 1 GB acrescenta US$ 0,25/mês. Estimativa: US$ 85,25/mês adicionais, sem impostos, câmbio, tráfego excedente, eventuais cobranças do workspace e sem incluir backend/banco existentes. Confira a estimativa do painel antes de confirmar.

O Render também oferece `1c-2g` por US$ 25/mês mais disco, mas esse tamanho fica abaixo da recomendação acima; exigiria um teste de carga e memória para decidir se serve a uma sessão. O arquivo não contrata esse plano menor automaticamente.

O disco pago mantém `/app/.sessions` entre reinícios e deploys. O plano gratuito não permite esse disco. A sessão é identificada pelo worker estável `bilhetou-waha`. QR Codes não são impressos nos logs. Chaves e senhas são geradas pelo Render ao importar o Blueprint, sem segredos no repositório.

## Criar o serviço

Uma conexão autorizada com o Render permite revisar os recursos da conta antes da criação. Sem essa conexão, estes são os campos equivalentes no painel:

1. Abra **New → Web Service → Existing Image**.
2. Informe `docker.io/devlikeapro/waha:latest` e clique em **Connect**.
3. Nome: `bilhetou-waha`. Região: a mesma do backend. Plano: `2c-4g` (antigo Pro), sujeito à aprovação do custo.
4. Não sobrescreva o comando Docker: use o padrão da imagem.
5. Adicione as variáveis do arquivo `render.waha.yaml`. Para criação manual, substitua os três `generateValue: true` por segredos aleatórios distintos. Você pode gerar cada um no PowerShell com `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"`. Guarde os valores diretamente no Render e no seu gerenciador de senhas; não envie as chaves no chat.
6. Em **Advanced**, adicione um disco de 1 GB montado em `/app/.sessions`.
7. Confira plano, disco e preço antes de confirmar **Deploy Web Service**.

Alternativamente, após publicar o arquivo no repositório, importe-o como Blueprint pelo caminho `render.waha.yaml`. Ajuste a região para a do backend antes da criação. O Blueprint usa a tag `latest` para a instalação inicial: depois de testar a sessão, registre o digest da imagem implantada e fixe-o no serviço para que uma atualização futura seja intencional.

Referências: [imagem Docker no Render](https://render.com/docs/deploying-an-image), [discos persistentes](https://render.com/docs/disks), [Blueprint](https://render.com/docs/blueprint-spec), [segurança do WAHA](https://waha.devlike.pro/docs/how-to/security/).

## Conectar o número

1. Aguarde o serviço ficar Live e copie a URL pública HTTPS exibida pelo Render.
2. Abra `https://ENDERECO-DO-WAHA/dashboard`.
3. Entre com usuário `admin` e o valor de `WAHA_DASHBOARD_PASSWORD`.
4. Se o painel pedir uma conexão à API, use a URL HTTPS do próprio serviço e `WAHA_API_KEY`, sem compartilhar a chave no chat. Não use localhost nessa conexão.
5. Crie/inicie a sessão `default`, exiba o QR e escaneie em **WhatsApp → Aparelhos conectados → Conectar aparelho** no celular remetente. Aguarde o estado `WORKING`.
6. Reinicie o serviço uma vez para verificar que a sessão volta sem pedir novo QR. Isso valida a persistência do disco antes de habilitar os envios.

## Conectar ao backend

Publique as alterações do backend e frontend já preparadas no workspace. No serviço **do backend**, em Environment, configure:

```dotenv
WAHA_ENABLED=true
WAHA_BASE_URL=https://ENDERECO-DO-WAHA
WAHA_API_KEY=mesmo-valor-do-servico-waha
WAHA_SESSION=default
```

A URL é a raiz do serviço, sem `/api` e sem `/dashboard`. No backend, o build deve continuar `npm ci --include=dev && npm run prisma:generate && npm run build`; o início deve ser `npm run prisma:deploy && npm start`. A migração cria a fila persistente. Faça deploy do backend e do frontend atualizado.

Se backend e WAHA estiverem na mesma região e rede privada compatível, prefira o endereço interno exibido pelo Render, com `http://HOST-INTERNO:3000`, para a comunicação da API. O painel pode continuar sendo acessado por HTTPS. A API do WAHA exige chave e o painel exige senha.

Para validar o fluxo, cadastre outro número sob seu controle e marque a autorização no site. Confira a mensagem e a linha da tabela `WhatsappWelcome`. `SENT` significa aceite pelo WAHA; o resultado real deve ser conferido no telefone. Consulte [WHATSAPP.md](WHATSAPP.md) para estados e tratamento de falhas.
