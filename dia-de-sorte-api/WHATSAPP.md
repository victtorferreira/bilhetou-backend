# Confirmação de cadastro via WAHA

O formulário permite solicitar uma confirmação por WhatsApp (opcional, desmarcado inicialmente). O cadastro e a mensagem pendente são gravados na mesma transação PostgreSQL. A autorização registrada corresponde ao texto `welcome-v1`: “Quero receber a confirmação do meu cadastro pelo WhatsApp do Bilhetou.” Não autoriza campanhas promocionais.

## Ativar

Para a implantação escolhida na OVHcloud, siga [WAHA-OVH.md](WAHA-OVH.md). Os arquivos Docker, HTTPS e geração de segredos estão em `deploy/ovh`.

Para hospedar o novo serviço no Render, consulte [WAHA-RENDER.md](WAHA-RENDER.md), com os campos do painel, configuração preparada em Blueprint e custo para revisão antes da criação.

1. Disponibilize uma instância WAHA em um servidor com armazenamento persistente para a sessão. Proteja a API com chave e restrinja o acesso à rede do backend. Veja [instalação](https://waha.devlike.pro/docs/how-to/install/) e [segurança](https://waha.devlike.pro/docs/how-to/security/).
   Para uso local, preencha `WAHA_API_KEY`, `WAHA_DASHBOARD_PASSWORD` e `WAHA_SWAGGER_PASSWORD` no `.env` com segredos distintos e rode `docker compose -f docker-compose.waha.yml up -d`. O painel fica em `http://127.0.0.1:3001/dashboard`, com usuário `admin`. A sessão persiste no volume `waha_sessions`. Para produção, fixe uma versão de imagem testada e publique em rede privada ou por HTTPS com acesso restrito.
2. No painel do WAHA, crie/inicie a sessão `default`, leia o QR Code com o WhatsApp remetente e aguarde o estado `WORKING`.
3. No diretório da API, rode `npm run prisma:generate`, `npm run prisma:deploy` e `npm run build`. A migração cria apenas a tabela de mensagens; não dispara envios para cadastros antigos.
4. Configure no ambiente **do backend**:

```dotenv
WAHA_ENABLED=true
WAHA_BASE_URL=https://seu-servidor-waha
WAHA_API_KEY=sua-chave-do-waha
WAHA_SESSION=default
```

`WAHA_BASE_URL` é a raiz do servidor, sem `/api` no final. Para WAHA local na porta 3001, use `http://127.0.0.1:3001`. Em containers distintos, use o endereço interno alcançável pelo backend. Nunca coloque a chave no frontend/Vercel com prefixo `VITE_`. Reinicie a API após configurar.

5. Faça um cadastro com um número sob seu controle e marque a autorização. O worker verifica a fila a cada 5 segundos, consulta o estado da sessão e resolve o identificador do contato antes de enviar. Não houve envio real durante a implementação.

Mensagem: “Olá, Maria! 👋 Bem-vindo ao Bilhetou. Seu cadastro foi realizado com sucesso! Esta é a confirmação de cadastro que você solicitou no site.”

## Operação

O worker roda junto da API, sem Redis. O host precisa manter a API em execução para processar a fila. A chave única por organização e telefone evita novas boas-vindas ao repetir um cadastro, inclusive em outra sessão, sem restaurar a identidade pelo telefone. O claim atômico com `SKIP LOCKED` permite múltiplas instâncias. Cada instância processa no máximo uma mensagem por ciclo.

Autorização explícita grava a mensagem mesmo se o worker estiver desativado. Pendências com mais de 24 horas expiram quando o worker voltar. Sem autorização, nenhum envio é criado. O cadastro continua funcionando se o WAHA estiver fora do ar; a API depende apenas da gravação no próprio banco.

Estados da tabela `WhatsappWelcome`:

| Estado | Significado |
| --- | --- |
| PENDING | Aguardando envio ou nova consulta ao WAHA. |
| PROCESSING | Reservada por um worker. |
| SENT | WAHA aceitou o envio e retornou um identificador; não comprova entrega/leitura. |
| FAILED | Número inexistente, erro HTTP de cliente no envio ou dez tentativas de consulta esgotadas. |
| UNKNOWN | Timeout/erro de servidor após tentativa de envio, resposta sem ID ou processamento interrompido por mais de dois minutos. Conferir no WAHA antes de qualquer reenvio. |
| EXPIRED | A confirmação ficou pendente por mais de 24 horas. |

Falhas antes do POST de envio são repetidas com espera progressiva de 30 segundos até uma hora, no máximo dez tentativas. Falhas após iniciar o envio não são repetidas automaticamente: WAHA não fornece aqui uma garantia de idempotência e o destinatário pode já ter recebido a mensagem. Não há garantia de exatamente uma entrega entre sistemas.

Para acompanhar sem exibir dados pessoais:

```sql
SELECT "status", COUNT(*) FROM "WhatsappWelcome" GROUP BY "status";
SELECT "id", "status", "attempts", "lastError", "providerMessageId"
FROM "WhatsappWelcome" ORDER BY "consentedAt" DESC LIMIT 50;
```

As mensagens ficam no banco e sobrevivem ao reinício. Logs usam somente o ID interno e o estado; não registram telefone, texto, chave ou respostas completas do provedor. Para pausar o worker, defina `WAHA_ENABLED=false` e reinicie. O recebimento das boas-vindas não altera a verificação do telefone: o cadastro continua `unverified`.
