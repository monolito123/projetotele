# Servidor getvid (yt-dlp)

Sites como y2mate e savefrom funcionam porque têm **um servidor** que baixa o vídeo e repassa para você. O YouTube não deixa um site sem servidor fazer isso. Este é o servidor do getvid, feito com o **yt-dlp**, que suporta mais de 1.000 sites (YouTube, Instagram, Facebook, Vimeo, Twitch, SoundCloud, Rumble, Kick…).

**Melhor lugar para rodar:** um computador ou celular **na sua casa, no Brasil**. O YouTube bloqueia muitos servidores de nuvem. A sua conexão de casa é tratada como um usuário normal, e vídeos que só podem ser vistos no Brasil também funcionam.

Depois de ligar o servidor, copie o endereço que ele mostrar e cole no site em **⚙ Configurações → Servidores cobalt**, depois clique em **Salvar**. Pronto: o site usa o seu servidor primeiro.

---

## Opção 1: Computador com Windows (mais fácil)

1. Instale o **Python** em <https://www.python.org/downloads/>. Na instalação, marque **"Add python.exe to PATH"**.
2. Instale o **cloudflared** (cria um endereço `https://` grátis, sem cadastro): abra o **Prompt de Comando** e rode
   ```
   winget install --id Cloudflare.cloudflared
   ```
3. Baixe o servidor: [getvid_server.py](https://monolito123.github.io/projetotele/server/getvid_server.py). Use clique direito → "Salvar como" e salve na pasta **Downloads**.
4. No Prompt de Comando, rode:
   ```
   cd %USERPROFILE%\Downloads
   pip install -U "yt-dlp[default,curl-cffi]"
   python getvid_server.py --tunnel
   ```
5. Vai aparecer um quadro com um endereço tipo `https://algumas-palavras.trycloudflare.com/`. **Cole esse endereço no site** (⚙ Configurações → Servidores cobalt) no celular ou no PC.

Deixe a janela aberta enquanto usa. O endereço muda toda vez que você reinicia; é só colar o novo.

## Opção 2: Mac ou Linux

```bash
# Mac (com Homebrew):  brew install python cloudflared
# Linux (Debian/Ubuntu): sudo apt install python3-pip ffmpeg   e instale o cloudflared pelo site da Cloudflare
pip3 install -U "yt-dlp[default,curl-cffi]"
curl -LO https://monolito123.github.io/projetotele/server/getvid_server.py
python3 getvid_server.py --tunnel
```

## Opção 3: Só o celular Android (Termux)

1. Instale o **Termux** pelo [F-Droid](https://f-droid.org/packages/com.termux/). A versão da Play Store é antiga.
2. No Termux, rode:
   ```
   pkg install -y python
   pip install -U yt-dlp
   curl -LO https://monolito123.github.io/projetotele/server/getvid_server.py
   python getvid_server.py
   ```
3. No Chrome **do mesmo celular**, cole `http://127.0.0.1:9100/` em ⚙ Configurações → Servidores cobalt. Se o Chrome perguntar se o site pode acessar dispositivos da rede local, toque em **Permitir**.

Deixe o Termux aberto (ou use "Acquire wakelock" na notificação do Termux) enquanto baixa.

## Opção 4: Docker (servidor sempre ligado)

```bash
cd server
docker compose up -d
docker compose logs tunnel | grep trycloudflare
```

## Opções avançadas

| Variável | Para quê |
|---|---|
| `PORT` | Porta (padrão `9100`) |
| `API_KEY` | Exige uma senha. No site, cole `endereço | senha` |
| `ALLOWED_ORIGINS` | Sites que podem usar o servidor (padrão: o getvid e `localhost`). Use `*` para liberar todos |

**Mantenha o yt-dlp atualizado**: os sites mudam com frequência. Se algo parar de funcionar, rode `pip install -U "yt-dlp[default,curl-cffi]"` e reinicie o servidor.

### Como funciona

O site manda o link. O servidor pede ao yt-dlp os formatos disponíveis e devolve um link `/tunnel` que repassa o arquivo, em pedaços de 10 MB para não ser limitado. Quando o site só oferece vídeo e áudio separados (o YouTube faz isso acima de 360p), o servidor entrega os dois e **o próprio site junta** com ffmpeg.wasm. Por isso o servidor não precisa de ffmpeg. Playlists e posts com vários vídeos viram uma lista para você escolher.
