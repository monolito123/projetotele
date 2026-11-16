# Servidor do getvid na Oracle Cloud (Always Free)

Tempo: uns 15 minutos. Custo: zero (o plano "Always Free" não cobra). No fim você tem um endereço `https://…` fixo, ligado 24 h. O site passa a usar esse servidor para todos os visitantes.

## 1. Criar a conta Oracle

1. Acesse <https://signup.cloud.oracle.com> e crie a conta. O cartão é pedido só para verificação; o Always Free não cobra.
2. Em **Home Region**, escolha **Brazil East (São Paulo)** ou **Brazil Southeast (Vinhedo)**. Isso **não pode ser mudado depois**, e os recursos grátis só existem na região principal. Um IP no Brasil ajuda com vídeos que só podem ser vistos aqui.

## 2. (Recomendado) Pegar um endereço grátis no DuckDNS

1. Acesse <https://www.duckdns.org> e entre com sua conta do **GitHub**.
2. Crie um subdomínio, por exemplo `meugetvid`. O endereço vai ser `meugetvid.duckdns.org`.
3. Copie o **token**, que aparece no topo da página.

Sem DuckDNS também funciona: o endereço vira `IP-com-traços.sslip.io`. Mas esse serviço é compartilhado por muita gente e às vezes demora para conseguir o certificado HTTPS.

## 3. Criar a máquina virtual

No painel da Oracle: **☰ → Compute → Instances → Create instance**.

| Campo | O que escolher |
|---|---|
| **Name** | `getvid` |
| **Image** | *Change image* → **Canonical Ubuntu** → **24.04** |
| **Shape** | *Change shape* → **Ampere** → **VM.Standard.A1.Flex** com **2 OCPU** e **12 GB**. Se aparecer *Out of capacity*, tente outro *Availability domain* ou use **Specialty and previous generation → VM.Standard.E2.1.Micro** (também grátis) |
| **Networking** | Deixe o padrão (cria a rede) e **Assign a public IPv4 address = Sim** |
| **Add SSH keys** | *Generate a key pair for me* → **Save private key** (guarde o arquivo) |

Depois, mais abaixo: **Show advanced options → Management → Paste cloud-init script**.

1. Abra <https://monolito123.github.io/projetotele/server/oracle-setup.sh> e copie **tudo**.
2. Cole na caixa e, se fez o passo 2, preencha as duas linhas do topo:
   ```
   MEU_DUCKDNS="meugetvid"
   MEU_DUCKDNS_TOKEN="seu-token-aqui"
   ```
3. Clique em **Create**.

## 4. Liberar as portas 80 e 443

1. Na página da máquina, clique na **Subnet**, que fica em *Primary VNIC*.
2. Clique em **Default Security List** e depois em **Add Ingress Rules**.
3. Preencha **Source CIDR** `0.0.0.0/0`, **IP Protocol** `TCP` e **Destination Port Range** `80,443`.
4. Clique em **Add Ingress Rules**.

## 5. Conferir

Espere de 5 a 10 minutos: a máquina instala tudo sozinha. Depois abra no navegador:

- com DuckDNS: `https://meugetvid.duckdns.org/`
- sem DuckDNS: o **IP público** da máquina (aparece na página dela) com traços, por exemplo `150.230.10.20` → `https://150-230-10-20.sslip.io/`

Se aparecer um texto começando com `{"cobalt":`, **está pronto**. Mande esse endereço para incluí-lo no site, ou coloque você mesmo em [`js/config.js`](../js/config.js):

```js
export const PROJECT_SERVERS = [
  'https://meugetvid.duckdns.org/',
];
```

Para testar só no seu aparelho antes, cole o endereço em **⚙ Configurações → Servidores cobalt** no site.

## Se algo não funcionar

Entre na máquina por SSH, usando a chave que você baixou: `ssh -i chave.key ubuntu@IP-PÚBLICO`. Depois:

| Comando | Para quê |
|---|---|
| `cat /var/log/getvid-setup.log` | ver o que a instalação fez |
| `journalctl -u getvid -f` | registros do servidor |
| `journalctl -u caddy -f` | registros do HTTPS (certificado) |
| `curl -fsSL https://monolito123.github.io/projetotele/server/oracle-setup.sh \| sudo DUCKDNS_DOMAIN=meugetvid DUCKDNS_TOKEN=xxx bash` | rodar a instalação de novo (pode repetir sem problema) |

- **O endereço não abre:** quase sempre são as portas do passo 4.
- **YouTube pedindo "confirme que você não é um robô":** servidores de nuvem são mais vigiados pelo YouTube. A instalação já inclui o gerador de *PO token*, que reduz isso. Se ainda acontecer, o site cai automaticamente para os servidores públicos e para o botão do loader.to. Último recurso: exportar os cookies de uma conta **secundária** do YouTube (extensão "Get cookies.txt LOCALLY"), salvar em `/opt/getvid/cookies.txt` e adicionar `Environment=YTDLP_COOKIES=/opt/getvid/cookies.txt` em `/etc/systemd/system/getvid.service`. Depois rode `sudo systemctl daemon-reload && sudo systemctl restart getvid`.
- **Máquina "recuperada" pela Oracle:** a Oracle pode desligar máquinas grátis que ficam quase sem uso por 7 dias. Converter a conta para *Pay As You Go* (continua grátis dentro dos limites) evita isso.

## O que a instalação faz

- Instala o servidor getvid (yt-dlp) como serviço, que reinicia sozinho.
- Configura o Caddy com HTTPS automático (Let's Encrypt).
- Liga o gerador de PO token do YouTube (Docker).
- Atualiza tudo diariamente: yt-dlp, o plugin e o próprio servidor.
- Abre as portas no firewall da máquina.
- Cria 2 GB de swap nas máquinas pequenas.
- Limita 30 pedidos a cada 5 minutos por visitante e 6 downloads simultâneos, para ninguém abusar do seu servidor.
- Só aceita pedidos vindos do site do getvid.
